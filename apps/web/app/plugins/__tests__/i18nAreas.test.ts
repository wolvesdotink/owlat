import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The area-catalog plugin (plan 3.4) is what makes a route wait for its
 * messages: the chunk download starts in `beforeEach`, the navigation waits in
 * `beforeResolve`, a language switch merges the areas in use first, and a
 * still-missing key renders as nothing instead of its path. The runtime logic
 * has its own suite (areaRuntime.test.ts); this pins the wiring.
 */

const manifest = vi.hoisted(() => ({
	areaRoutes: [] as Array<{ path: string; exact: boolean; area: string }>,
	messageRoots: ['dashboard'],
	areaChunks: {} as Record<string, Record<string, () => Promise<{ default: object }>>>,
}));
vi.mock('#build/owlat-i18n-areas.mjs', () => manifest);

type Guard = (to: { path: string }) => unknown;
type Hook = (payload: { newLocale: string }) => Promise<void>;

function fakeApp(locale = 'en') {
	const guards: { beforeEach?: Guard; beforeResolve?: Guard } = {};
	const hooks: Record<string, Hook> = {};
	const i18n = {
		locale: { value: locale },
		mergeLocaleMessage: vi.fn(),
		setMissingHandler: vi.fn(),
	};
	vi.stubGlobal('useRouter', () => ({
		beforeEach: (guard: Guard) => (guards.beforeEach = guard),
		beforeResolve: (guard: Guard) => (guards.beforeResolve = guard),
	}));
	const nuxtApp = { $i18n: i18n, hook: (name: string, hook: Hook) => (hooks[name] = hook) };
	return { nuxtApp, guards, hooks, i18n };
}

async function runPlugin(nuxtApp: unknown) {
	vi.resetModules();
	const plugin = (await import('../i18n-areas.client')).default as unknown as {
		dependsOn: string[];
		setup: (app: unknown) => void;
	};
	expect(plugin.dependsOn).toEqual(['i18n:plugin']);
	plugin.setup(nuxtApp);
}

describe('i18n-areas plugin', () => {
	beforeEach(() => {
		manifest.areaRoutes = [{ path: '/dashboard/admin', exact: false, area: 'dashboard-admin' }];
		manifest.areaChunks = {
			'dashboard-admin': {
				en: async () => ({ default: { dashboard: { admin: { title: 'Admin' } } } }),
				de: async () => ({ default: { dashboard: { admin: { title: 'Verwaltung' } } } }),
			},
		};
	});

	it('does nothing without chunks (the dev server)', async () => {
		manifest.areaRoutes = [];
		const { nuxtApp, guards, i18n } = fakeApp();
		await runPlugin(nuxtApp);
		expect(guards).toEqual({});
		expect(i18n.setMissingHandler).not.toHaveBeenCalled();
	});

	it('merges the area’s messages before the navigation resolves', async () => {
		const { nuxtApp, guards, i18n } = fakeApp();
		await runPlugin(nuxtApp);
		guards.beforeEach!({ path: '/dashboard/admin/team' });
		expect(i18n.mergeLocaleMessage).not.toHaveBeenCalled();
		await guards.beforeResolve!({ path: '/dashboard/admin/team' });
		expect(i18n.mergeLocaleMessage).toHaveBeenCalledWith('en', {
			dashboard: { admin: { title: 'Admin' } },
		});
	});

	it('merges the areas in use in the new language before a switch lands', async () => {
		const { nuxtApp, guards, hooks, i18n } = fakeApp();
		await runPlugin(nuxtApp);
		await guards.beforeResolve!({ path: '/dashboard/admin' });
		await hooks['i18n:beforeLocaleSwitch']!({ newLocale: 'de' });
		expect(i18n.mergeLocaleMessage).toHaveBeenLastCalledWith('de', {
			dashboard: { admin: { title: 'Verwaltung' } },
		});
	});

	it('installs the missing-key net', async () => {
		const { nuxtApp, i18n } = fakeApp();
		await runPlugin(nuxtApp);
		const missing = i18n.setMissingHandler.mock.calls[0]![0] as (l: string, k: string) => unknown;
		expect(missing('en', 'dashboard.admin.title')).toBe('');
		expect(missing('en', 'Plain words')).toBeUndefined();
	});
});
