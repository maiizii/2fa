import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createServiceWorker } from '../../src/ui/serviceworker.js';

async function createWorker(fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))) {
	const handlers = {};
	const context = vm.createContext({
		console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
		URL,
		Response,
		fetch,
		self: {
			addEventListener: (name, callback) => {
				handlers[name] = callback;
			},
			registration: { sync: { register: vi.fn().mockResolvedValue() } },
		},
	});
	vm.runInContext(await createServiceWorker().text(), context);
	// Keep the generated worker logic real; replace only persistence and client messaging.
	context.saveOperation = vi.fn().mockResolvedValue('queued-id');
	context.getPendingOperations = vi.fn().mockResolvedValue([]);
	context.deleteOperation = vi.fn().mockResolvedValue();
	context.notifyClients = vi.fn().mockResolvedValue();
	return {
		context,
		request(path, method = 'POST') {
			let response;
			handlers.fetch({
				request: new Request('https://example.test' + path, {
					method,
					headers: { 'Content-Type': 'application/json' },
					...(method === 'GET' ? {} : { body: JSON.stringify({ credential: 'synthetic-test-value' }) }),
				}),
				respondWith(promise) {
					response = promise;
				},
			});
			return response;
		},
	};
}

const authPaths = ['/api/login', '/api/setup', '/api/refresh-token'];

describe('authentication requests in the service worker', () => {
	it.each(authPaths)('never queues %s after a transport failure', async (path) => {
		const worker = await createWorker();
		const response = await worker.request(path);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ success: false, offline: true });
		expect(worker.context.saveOperation).not.toHaveBeenCalled();
		expect(worker.context.self.registration.sync.register).not.toHaveBeenCalled();
	});

	it.each([200, 401, 429, 503])('passes through online HTTP %s without queuing', async (status) => {
		const upstream = Response.json(
			{ success: status === 200 },
			{
				status,
				headers: status === 200 ? { 'Set-Cookie': 'auth_token=test; HttpOnly; Secure; SameSite=Strict; Path=/' } : {},
			},
		);
		const worker = await createWorker(vi.fn().mockResolvedValue(upstream));
		expect(await worker.request('/api/login')).toBe(upstream);
		expect(worker.context.saveOperation).not.toHaveBeenCalled();
	});

	it.each([
		['/api/secrets', 'POST', 'ADD'],
		['/api/secrets/batch', 'POST', 'BATCH_ADD'],
		['/api/secrets/test-id', 'PUT', 'UPDATE'],
		['/api/secrets/test-id', 'DELETE', 'DELETE'],
	])('preserves offline mutations for %s %s', async (path, method, type) => {
		const worker = await createWorker();
		const response = await worker.request(path, method);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ success: true, queued: true });
		expect(worker.context.saveOperation).toHaveBeenCalledWith(expect.objectContaining({ type }));
	});

	it('discards legacy queued authentication requests without replaying them', async () => {
		const worker = await createWorker(vi.fn().mockResolvedValue(Response.json({ success: true })));
		worker.context.getPendingOperations.mockResolvedValue([
			...authPaths.map((url, index) => ({ id: 'auth-' + index, url, method: 'POST', timestamp: index })),
			{ id: 'secret', url: '/api/secrets', method: 'POST', timestamp: 4, data: { name: 'test' } },
		]);
		await worker.context.syncPendingOperations();
		expect(worker.context.fetch).toHaveBeenCalledOnce();
		expect(worker.context.fetch).toHaveBeenCalledWith('/api/secrets', expect.objectContaining({ credentials: 'include' }));
		for (let index = 0; index < authPaths.length; index++) {
			expect(worker.context.deleteOperation).toHaveBeenCalledWith('auth-' + index);
		}
	});
});
