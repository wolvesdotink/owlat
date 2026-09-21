import { describe, it, expect, vi } from 'vitest';
import {
	SERVICE_WORKER_URL,
	SHELL_CACHE_PREFIX,
	clearShellCaches,
	decideServiceWorkerAction,
	describeShellStatus,
	isOwnServiceWorker,
	type ServiceWorkerEnv,
} from '../offlineShell';
import { createTestI18n } from '~/__tests__/i18n';

/** The status registry hands back keys; this is the render boundary. */
const { t } = createTestI18n().global;

const web: ServiceWorkerEnv = {
	supported: true,
	isDesktopBuild: false,
	isDev: false,
	enabled: true,
};

describe('decideServiceWorkerAction', () => {
	it('registers on a production web build', () => {
		expect(decideServiceWorkerAction(web)).toBe('register');
	});

	it('does nothing at all when service workers are unsupported', () => {
		// Nothing to register, and nothing could have been registered — an
		// unregister attempt here would throw on the missing API.
		expect(decideServiceWorkerAction({ ...web, supported: false })).toBe('skip');
	});

	it.each([
		['the desktop build', { isDesktopBuild: true }],
		['dev', { isDev: true }],
		['the kill switch being off', { enabled: false }],
	])('UNregisters (never merely skips) for %s', (_case, patch) => {
		// The load-bearing branch: a worker installed by an earlier production
		// visit outlives the flag that installed it, so "off" has to tear down.
		expect(decideServiceWorkerAction({ ...web, ...patch })).toBe('unregister');
	});
});

describe('isOwnServiceWorker', () => {
	const script = (path: string) => ({ scriptURL: `https://mail.example.com${path}` });

	it('matches our worker in any registration slot', () => {
		expect(isOwnServiceWorker({ active: script(SERVICE_WORKER_URL) })).toBe(true);
		expect(isOwnServiceWorker({ waiting: script(SERVICE_WORKER_URL) })).toBe(true);
		// Caught mid-install: no active worker yet, but it must still be removed.
		expect(isOwnServiceWorker({ installing: script(SERVICE_WORKER_URL) })).toBe(true);
	});

	it('leaves another worker on the same origin alone', () => {
		expect(isOwnServiceWorker({ active: script('/vendor/push-sw.js') })).toBe(false);
		// A path that merely ENDS in our filename is somebody else's worker.
		expect(isOwnServiceWorker({ active: script('/plugins/sw.js') })).toBe(false);
		expect(isOwnServiceWorker({})).toBe(false);
	});
});

describe('describeShellStatus', () => {
	it('hides itself on the desktop build', () => {
		// The desktop app is already local; there is no worker to report on.
		expect(describeShellStatus({ ...web, isDesktopBuild: true, controlled: false })).toBeNull();
	});

	it.each([
		['ready', { ...web, controlled: true }],
		['pending', { ...web, controlled: false }],
		['unsupported', { ...web, supported: false, controlled: false }],
		['disabled', { ...web, enabled: false, controlled: false }],
		['disabled', { ...web, isDev: true, controlled: false }],
	])('reports %s', (state, env) => {
		const status = describeShellStatus(env);
		expect(status?.key).toBe(`components.postbox.postboxOfflineSettings.shell.${state}`);
		// The key resolves — a registry entry nobody translated is a blank line.
		expect(t(status!.key)).not.toBe(status!.key);
	});
});

describe('clearShellCaches', () => {
	function cacheStorage(names: string[]) {
		const deleted: string[] = [];
		return {
			storage: {
				keys: async () => names,
				delete: async (name: string) => {
					deleted.push(name);
					return true;
				},
			} as unknown as CacheStorage,
			deleted,
		};
	}

	it('drops only our caches', async () => {
		const { storage, deleted } = cacheStorage([
			`${SHELL_CACHE_PREFIX}abc`,
			`${SHELL_CACHE_PREFIX}def`,
			'workbox-precache-v2',
			'some-other-app',
		]);

		await expect(clearShellCaches(storage)).resolves.toBe(2);
		expect(deleted).toEqual([`${SHELL_CACHE_PREFIX}abc`, `${SHELL_CACHE_PREFIX}def`]);
	});

	it('is a no-op without CacheStorage, and swallows a throwing one', async () => {
		expect(await clearShellCaches(undefined)).toBe(0);
		const throwing = { keys: vi.fn(async () => Promise.reject(new Error('blocked'))) };
		expect(await clearShellCaches(throwing as unknown as CacheStorage)).toBe(0);
	});
});
