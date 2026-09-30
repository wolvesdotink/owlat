import { describe, it, expect, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { isPublicPath, isPublicRoute, useLeftPublicPages } from '../publicRoutes';

function onRoute(path: string) {
	const route = reactive({ path });
	vi.stubGlobal('useRoute', () => route);
	return route;
}

describe('public routes', () => {
	it('knows the public pages', () => {
		expect(isPublicPath('/terms')).toBe(true);
		expect(isPublicPath('/share')).toBe(true);
		expect(isPublicPath('/dashboard')).toBe(false);
		expect(isPublicPath('/auth/login')).toBe(false);
	});

	it('reads the current route', () => {
		onRoute('/imprint');
		expect(isPublicRoute()).toBe(true);
		onRoute('/dashboard');
		expect(isPublicRoute()).toBe(false);
	});
});

describe('useLeftPublicPages', () => {
	it('is on from the start on an app route', () => {
		onRoute('/dashboard');
		expect(useLeftPublicPages().value).toBe(true);
	});

	it('turns on when a visit that began on a public page enters the app, and stays on', async () => {
		const route = onRoute('/terms');
		const left = useLeftPublicPages();
		expect(left.value).toBe(false);

		route.path = '/imprint';
		await nextTick();
		expect(left.value).toBe(false);

		route.path = '/auth/login';
		await nextTick();
		expect(left.value).toBe(true);

		route.path = '/terms';
		await nextTick();
		expect(left.value).toBe(true);
	});
});
