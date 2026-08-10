import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const navigateTo = vi.fn((path: string) => path);
const isAuthenticated = ref(true);
const isLoading = ref(false);
const isAdmin = ref(false);
const waitUntilReady = vi.fn(async () => undefined);
const waitForLoaded = vi.fn(async () => undefined);

vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn);
vi.stubGlobal('navigateTo', navigateTo);
vi.stubGlobal('useAuth', () => ({ isAuthenticated, waitUntilReady }));
vi.stubGlobal('useOrganizationContext', () => ({ isLoading }));
vi.stubGlobal('usePermissions', () => ({ isAdmin }));
vi.stubGlobal('waitForLoaded', waitForLoaded);

const middleware = (await import('../admin')).default as () => Promise<unknown>;

describe('admin middleware', () => {
	beforeEach(() => {
		navigateTo.mockClear();
		waitUntilReady.mockClear();
		waitForLoaded.mockClear();
		isAuthenticated.value = true;
		isAdmin.value = false;
	});

	it('fails closed for an editor deep link', async () => {
		await expect(middleware()).resolves.toBe('/dashboard');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard', { replace: true });
	});

	it('allows an owner or admin after role resolution', async () => {
		isAdmin.value = true;
		await expect(middleware()).resolves.toBeUndefined();
		expect(waitForLoaded).toHaveBeenCalledWith(isLoading);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('sends an expired session to sign in before checking role', async () => {
		isAuthenticated.value = false;
		await expect(middleware()).resolves.toBe('/auth/login');
		expect(navigateTo).toHaveBeenCalledWith('/auth/login');
		expect(waitForLoaded).not.toHaveBeenCalled();
	});
});
