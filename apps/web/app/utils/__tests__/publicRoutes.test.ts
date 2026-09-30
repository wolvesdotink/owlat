import { describe, it, expect, vi } from 'vitest';
import { reactive } from 'vue';
import { isPublicPath, isPublicRoute } from '../publicRoutes';

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
