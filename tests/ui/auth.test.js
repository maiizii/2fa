import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getAuthCode } from '../../src/ui/scripts/auth.js';
import { createSetupPage } from '../../src/ui/setupPage.js';

function createContext(response) {
	const elements = {
		loginToken: { value: 'Test-password1', focus: vi.fn() },
		loginError: { style: {}, textContent: '' },
		loginModal: { style: { display: 'flex' } },
	};
	const context = vm.createContext({
		console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
		document: { getElementById: (id) => elements[id] },
		fetch: vi.fn().mockResolvedValue(response),
		showCenterToast: vi.fn(),
		loadSecrets: vi.fn(),
	});
	vm.runInContext(getAuthCode(), context);
	return { context, elements };
}

const rejectedResponses = [
	[202, { success: true, queued: true, offline: true, message: 'Queued for sync' }],
	[200, { success: true, queued: true }],
	[200, { success: true, offline: true }],
	[200, { success: false }],
	[503, { success: false, offline: true, message: 'Network unavailable' }],
	[401, { success: false, message: 'Incorrect password' }],
];

describe('authentication response handling', () => {
	it.each(rejectedResponses)('keeps login open for HTTP %s with %j', async (status, data) => {
		const { context, elements } = createContext(Response.json(data, { status }));
		await context.handleLoginSubmit();
		expect(elements.loginModal.style.display).toBe('flex');
		expect(elements.loginError.style.display).toBe('block');
		expect(elements.loginError.textContent).not.toContain('Queued for sync');
		expect(context.loadSecrets).not.toHaveBeenCalled();
		expect(context.showCenterToast).not.toHaveBeenCalled();
	});

	it('accepts a successful online login and includes cookies', async () => {
		const { context, elements } = createContext(Response.json({ success: true, expiresIn: '30 days' }));
		await context.handleLoginSubmit();
		expect(elements.loginModal.style.display).toBe('none');
		expect(context.loadSecrets).toHaveBeenCalledOnce();
		expect(context.fetch).toHaveBeenCalledWith('/api/login', expect.objectContaining({ credentials: 'include' }));
	});

	it('keeps login open after a transport failure', async () => {
		const { context, elements } = createContext();
		context.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
		await context.handleLoginSubmit();
		expect(elements.loginModal.style.display).toBe('flex');
		expect(elements.loginError.style.display).toBe('block');
		expect(context.loadSecrets).not.toHaveBeenCalled();
	});

	it.each(rejectedResponses)('rejects token refresh for HTTP %s with %j', async (status, data) => {
		const { context } = createContext(Response.json(data, { status }));
		expect(await context.refreshAuthToken()).toBe(false);
	});

	it('accepts a successful online token refresh', async () => {
		const { context } = createContext(Response.json({ success: true }));
		expect(await context.refreshAuthToken()).toBe(true);
	});
});

describe('setup response handling', () => {
	it.each([...rejectedResponses, [200, { success: true }]])('handles HTTP %s with %j', async (status, data) => {
		const html = await (await createSetupPage()).text();
		const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
		const elements = new Map();
		const context = vm.createContext({
			console: { error: vi.fn() },
			document: {
				getElementById(id) {
					if (!elements.has(id)) {
						elements.set(id, { value: 'Test-password1', style: {}, addEventListener: vi.fn() });
					}
					return elements.get(id);
				},
			},
			fetch: vi.fn().mockResolvedValue(Response.json(data, { status })),
			setTimeout: vi.fn(),
		});
		vm.runInContext(script, context);
		context.showError = vi.fn();
		context.showSuccess = vi.fn();
		await context.handleSetup({ preventDefault: vi.fn() });
		if (status === 200 && data.success === true && !data.queued && !data.offline) {
			expect(context.showSuccess).toHaveBeenCalledOnce();
			expect(context.setTimeout).toHaveBeenCalledOnce();
		} else {
			expect(context.showSuccess).not.toHaveBeenCalled();
			expect(context.setTimeout).not.toHaveBeenCalled();
			expect(context.showError).toHaveBeenCalledOnce();
		}
	});
});
