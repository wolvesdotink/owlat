// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
	areasForPath,
	createAreaCatalogs,
	type AreaChunkLoader,
	type AreaMessages,
	type AreaRouteEntry,
} from '~~/i18n/areaRuntime';

/**
 * A build ships each locale as a boot catalog plus route-area chunks (plan
 * 3.4). These pin the runtime contract that keeps that invisible: an area's
 * messages are merged before its route resolves, a language switch brings every
 * area in use along, and a key that is still missing renders as nothing while
 * the chunks load rather than as its key path.
 */

const ROUTES: AreaRouteEntry[] = [
	{ path: '/dashboard', exact: true, area: 'dashboard' },
	{ path: '/dashboard/admin', exact: false, area: 'dashboard-admin' },
	{ path: '/setup', exact: false, area: 'setup' },
];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function harness(initialLocale = 'en') {
	let locale = initialLocale;
	const merged: Array<[string, AreaMessages]> = [];
	const loaders: Record<string, Record<string, ReturnType<typeof vi.fn<AreaChunkLoader>>>> = {};
	for (const area of ['dashboard', 'dashboard-admin', 'setup']) {
		loaders[area] = {};
		for (const code of ['en', 'de']) {
			loaders[area][code] = vi.fn<AreaChunkLoader>(async () => ({
				default: { [area]: { title: `${area} ${code}` } },
			}));
		}
	}
	const onError = vi.fn();
	const catalogs = createAreaCatalogs({
		routes: ROUTES,
		chunks: loaders,
		roots: ['common', 'dashboard', 'setup'],
		merge: (code, messages) => merged.push([code, messages]),
		locale: () => locale,
		onError,
	});
	return {
		catalogs,
		loaders,
		merged,
		onError,
		setLocale: (code: string) => (locale = code),
	};
}

describe('areasForPath', () => {
	it('matches an area on its own path and below it', () => {
		expect(areasForPath(ROUTES, '/dashboard/admin')).toEqual(['dashboard-admin']);
		expect(areasForPath(ROUTES, '/dashboard/admin/team/roles')).toEqual(['dashboard-admin']);
		expect(areasForPath(ROUTES, '/setup')).toEqual(['setup']);
	});

	it('matches an exact area only on its own path', () => {
		expect(areasForPath(ROUTES, '/dashboard')).toEqual(['dashboard']);
		expect(areasForPath(ROUTES, '/dashboard/')).toEqual(['dashboard']);
		expect(areasForPath(ROUTES, '/dashboard/postbox')).toEqual([]);
	});

	it('ignores case and does not match a sibling that merely shares a prefix', () => {
		expect(areasForPath(ROUTES, '/Dashboard/Admin/Team')).toEqual(['dashboard-admin']);
		expect(areasForPath(ROUTES, '/dashboard/administration')).toEqual([]);
		expect(areasForPath(ROUTES, '/setup-guide')).toEqual([]);
		expect(areasForPath(ROUTES, '/auth/login')).toEqual([]);
	});
});

describe('createAreaCatalogs', () => {
	it('merges the area chunk before ensure() resolves', async () => {
		const { catalogs, merged } = harness();
		await catalogs.ensure('/dashboard/admin/team');
		expect(merged).toEqual([['en', { 'dashboard-admin': { title: 'dashboard-admin en' } }]]);
	});

	it('waits for a slow chunk rather than letting the route render without it', async () => {
		const { catalogs, loaders, merged } = harness();
		const slow = deferred<{ default: AreaMessages }>();
		loaders['setup']!['en']!.mockImplementationOnce(() => slow.promise);
		let settled = false;
		const ensured = catalogs.ensure('/setup/instance').then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		slow.resolve({ default: { setup: { title: 'Setup' } } });
		await ensured;
		expect(merged).toEqual([['en', { setup: { title: 'Setup' } }]]);
	});

	it('downloads a chunk once, whether prefetched, ensured twice or ensured concurrently', async () => {
		const { catalogs, loaders, merged } = harness();
		catalogs.prefetch('/dashboard/admin');
		expect(merged).toEqual([]);
		await Promise.all([catalogs.ensure('/dashboard/admin'), catalogs.ensure('/dashboard/admin/x')]);
		await catalogs.ensure('/dashboard/admin');
		expect(loaders['dashboard-admin']!['en']).toHaveBeenCalledTimes(1);
		expect(merged).toHaveLength(1);
	});

	it('loads nothing for a route outside every area', async () => {
		const { catalogs, loaders, merged } = harness();
		catalogs.prefetch('/auth/login');
		await catalogs.ensure('/auth/login');
		expect(merged).toEqual([]);
		for (const locales of Object.values(loaders)) {
			for (const loader of Object.values(locales)) expect(loader).not.toHaveBeenCalled();
		}
	});

	it('merges every area in use in the new language on a locale switch', async () => {
		const { catalogs, merged, setLocale } = harness();
		await catalogs.ensure('/dashboard');
		await catalogs.ensure('/setup');
		merged.length = 0;
		await catalogs.switchLocale('de');
		expect(merged.map(([code, messages]) => [code, Object.keys(messages)[0]]).sort()).toEqual([
			['de', 'dashboard'],
			['de', 'setup'],
		]);
		setLocale('de');
		await catalogs.ensure('/setup');
		expect(merged).toHaveLength(2);
	});

	it('lets the route render after a failed download and retries on the next navigation', async () => {
		const { catalogs, loaders, merged, onError } = harness();
		const failure = new Error('offline');
		loaders['setup']!['en']!.mockRejectedValueOnce(failure);
		await catalogs.ensure('/setup');
		expect(onError).toHaveBeenCalledWith(failure);
		expect(merged).toEqual([]);
		await catalogs.ensure('/setup');
		expect(merged).toEqual([['en', { setup: { title: 'setup en' } }]]);
	});

	describe('missing', () => {
		it('hands plain text back untouched', () => {
			const { catalogs, loaders } = harness();
			expect(catalogs.missing('en', 'Amazon SES')).toBeUndefined();
			expect(catalogs.missing('en', 'v1.2')).toBeUndefined();
			expect(loaders['setup']!['en']).not.toHaveBeenCalled();
		});

		it('renders a missing key as nothing and loads every remaining chunk', async () => {
			const { catalogs, loaders, merged } = harness();
			await catalogs.ensure('/setup');
			expect(catalogs.missing('en', 'dashboard.admin.title')).toBe('');
			expect(catalogs.missing('en', 'dashboard.admin.other')).toBe('');
			await vi.waitFor(() => expect(merged).toHaveLength(3));
			expect(loaders['dashboard-admin']!['en']).toHaveBeenCalledTimes(1);
			expect(loaders['setup']!['en']).toHaveBeenCalledTimes(1);
			// Everything is loaded now: a key still missing is genuinely missing.
			expect(catalogs.missing('en', 'dashboard.admin.nope')).toBeUndefined();
		});

		it('stops blanking keys after a sweep that could not load everything', async () => {
			const { catalogs, loaders, onError } = harness();
			loaders['setup']!['en']!.mockRejectedValue(new Error('offline'));
			expect(catalogs.missing('en', 'setup.title')).toBe('');
			await vi.waitFor(() => expect(onError).toHaveBeenCalled());
			await vi.waitFor(() => expect(catalogs.missing('en', 'setup.title')).toBeUndefined());
		});
	});
});
