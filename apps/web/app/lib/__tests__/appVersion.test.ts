/**
 * The tab's version watch: when it decides the server runs another build,
 * and when it reloads on its own.
 *
 * What these cases protect:
 *   - ONE ANSWER. A different deployed build raises one update; the same
 *     build, a malformed answer or a failed request raise none.
 *   - CHEAP CHECKS. The server is asked on an interval while the tab is
 *     visible and when the person comes back, never more than once a minute.
 *   - SAFE RELOAD. A change of page reloads the tab at its destination only
 *     when nothing would be lost; otherwise it navigates as usual.
 *   - NO LOOPS. A reload that landed on the old build again does not reload
 *     by itself a second time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
import {
	CHECK_INTERVAL_MS,
	MIN_CHECK_GAP_MS,
	UPDATE_RELOAD_KEY,
	createAppVersionWatch,
	isComparableBuildId,
	parseDeployedBuild,
	releaseNotesUrl,
	type AppVersionWatch,
	type AppVersionWatchDeps,
} from '../appVersion';

const BOOT = 'build-a';
/** Let pending promise work run; the timers are fake, so no real time passes. */
const tick = () => vi.advanceTimersByTimeAsync(0);
const NEXT = { buildId: 'build-b', version: '0.6.17' };

describe('parseDeployedBuild', () => {
	it('takes a build id and a release version', () => {
		expect(parseDeployedBuild(NEXT)).toEqual(NEXT);
		expect(parseDeployedBuild({ buildId: 'b', version: 'v1.2.3-rc.1' })).toEqual({
			buildId: 'b',
			version: 'v1.2.3-rc.1',
		});
	});

	it('keeps the build but no version for a build that is not a release', () => {
		expect(parseDeployedBuild({ buildId: 'b', version: 'dev' })).toEqual({
			buildId: 'b',
			version: null,
		});
		expect(parseDeployedBuild({ buildId: 'b' })).toEqual({ buildId: 'b', version: null });
	});

	it('rejects anything without a usable build id', () => {
		for (const value of [
			null,
			'build-b',
			{},
			{ buildId: '' },
			{ buildId: 42 },
			{ buildId: 'dev' },
			{ buildId: 'x'.repeat(129) },
		]) {
			expect(parseDeployedBuild(value)).toBeNull();
		}
	});
});

describe('isComparableBuildId / releaseNotesUrl', () => {
	it('tells real builds from development and test runs', () => {
		expect(isComparableBuildId('3f1c2a')).toBe(true);
		expect(isComparableBuildId('dev')).toBe(false);
		expect(isComparableBuildId('test')).toBe(false);
		expect(isComparableBuildId(undefined)).toBe(false);
	});

	it('links the release page of a version, and nothing without one', () => {
		expect(releaseNotesUrl('0.6.17')).toBe(
			'https://github.com/wolvesdotink/owlat/releases/tag/v0.6.17'
		);
		expect(releaseNotesUrl('v0.6.17')).toBe(
			'https://github.com/wolvesdotink/owlat/releases/tag/v0.6.17'
		);
		expect(releaseNotesUrl(null)).toBeNull();
	});
});

function memoryStorage(initial: Record<string, string> = {}): Storage {
	const map = new Map(Object.entries(initial));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (index) => [...map.keys()][index] ?? null,
		removeItem: (key) => void map.delete(key),
		setItem: (key, value) => void map.set(key, String(value)),
	};
}

const Page = defineComponent({ render: () => null });

function testRouter(): Router {
	return createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', component: Page },
			{ path: '/inbox', component: Page },
			{ path: '/inbox/:id', component: Page },
			{ path: '/settings', component: Page },
		],
	});
}

interface Harness {
	watch: AppVersionWatch;
	router: Router;
	fetchDeployed: ReturnType<typeof vi.fn>;
	settleForReload: ReturnType<typeof vi.fn>;
	assign: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	storage: Storage;
	visible: { value: boolean };
	stop: () => void;
}

const stops: Array<() => void> = [];

async function harness(options: Partial<AppVersionWatchDeps> = {}): Promise<Harness> {
	const router = testRouter();
	await router.push('/inbox');
	const visible = { value: true };
	const deps = {
		bootBuildId: BOOT,
		fetchDeployed: vi.fn(async () => NEXT),
		router,
		settleForReload: vi.fn(async () => true),
		assign: vi.fn(),
		reload: vi.fn(),
		storage: memoryStorage(),
		isVisible: () => visible.value,
		...options,
	};
	const watch = createAppVersionWatch(deps);
	const stop = watch.start();
	stops.push(stop);
	return {
		watch,
		router,
		fetchDeployed: deps.fetchDeployed as ReturnType<typeof vi.fn>,
		settleForReload: deps.settleForReload as ReturnType<typeof vi.fn>,
		assign: deps.assign as ReturnType<typeof vi.fn>,
		reload: deps.reload as ReturnType<typeof vi.fn>,
		storage: deps.storage,
		visible,
		stop,
	};
}

function setVisibility(state: 'visible' | 'hidden') {
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
	document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.useRealTimers();
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('createAppVersionWatch: checking', () => {
	it('raises one update for a different deployed build', async () => {
		const h = await harness();
		expect(h.watch.update.value).toBeNull();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.fetchDeployed).toHaveBeenCalledTimes(1);
		expect(h.watch.update.value).toEqual(NEXT);

		// Known now: no further checks.
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
		expect(h.fetchDeployed).toHaveBeenCalledTimes(1);
	});

	it('raises nothing for the same build, a malformed answer or a failed request', async () => {
		const answers: Array<() => Promise<unknown>> = [
			async () => ({ buildId: BOOT, version: '0.6.16' }),
			async () => ({ version: '0.6.17' }),
			async () => '<html>',
			async () => null,
			async () => {
				throw new TypeError('Failed to fetch');
			},
		];
		const h = await harness({ fetchDeployed: vi.fn(() => answers.shift()!()) });
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(h.fetchDeployed).toHaveBeenCalledTimes(5);
		expect(h.watch.update.value).toBeNull();
	});

	it('skips the interval check while the tab is hidden', async () => {
		const h = await harness();
		h.visible.value = false;
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(h.fetchDeployed).not.toHaveBeenCalled();
	});

	it('checks when the person comes back, at most once a minute', async () => {
		const h = await harness({ fetchDeployed: vi.fn(async () => ({ buildId: BOOT })) });
		setVisibility('visible');
		expect(h.fetchDeployed).toHaveBeenCalledTimes(1);
		setVisibility('hidden');
		setVisibility('visible');
		window.dispatchEvent(new Event('online'));
		expect(h.fetchDeployed).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(MIN_CHECK_GAP_MS);
		window.dispatchEvent(new Event('online'));
		expect(h.fetchDeployed).toHaveBeenCalledTimes(2);
	});

	it('runs one check at a time', async () => {
		let answer!: (value: unknown) => void;
		const h = await harness({
			fetchDeployed: vi.fn(() => new Promise((resolve) => (answer = resolve))),
		});
		void h.watch.check();
		void h.watch.check();
		expect(h.fetchDeployed).toHaveBeenCalledTimes(1);
		answer(NEXT);
		await tick();
		expect(h.watch.update.value).toEqual(NEXT);
	});

	it('stops checking once stopped', async () => {
		const h = await harness();
		h.stop();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		setVisibility('visible');
		expect(h.fetchDeployed).not.toHaveBeenCalled();
	});
});

describe('createAppVersionWatch: reloading on navigation', () => {
	it('navigates as usual while the tab runs the deployed build', async () => {
		const h = await harness();
		await h.router.push('/settings');
		expect(h.router.currentRoute.value.path).toBe('/settings');
		expect(h.settleForReload).not.toHaveBeenCalled();
	});

	it('reloads once at the destination when nothing would be lost', async () => {
		const h = await harness();
		await h.watch.check();
		const result = await h.router.push('/settings?tab=general');
		expect(result).toBeDefined(); // aborted: the page is being replaced
		expect(h.router.currentRoute.value.path).toBe('/inbox');
		expect(h.assign).toHaveBeenCalledTimes(1);
		expect(h.assign).toHaveBeenCalledWith('/settings?tab=general');
		expect(h.storage.getItem(UPDATE_RELOAD_KEY)).toBe(NEXT.buildId);

		await h.router.push('/');
		expect(h.assign).toHaveBeenCalledTimes(1);
	});

	it('navigates without reloading when something would be lost', async () => {
		const h = await harness({ settleForReload: vi.fn(async () => false) });
		await h.watch.check();
		await h.router.push('/settings');
		expect(h.router.currentRoute.value.path).toBe('/settings');
		expect(h.assign).not.toHaveBeenCalled();
	});

	it('stays in place for a change of query or hash on the same page', async () => {
		const h = await harness();
		await h.watch.check();
		await h.router.push('/inbox?filter=unread');
		expect(h.router.currentRoute.value.fullPath).toBe('/inbox?filter=unread');
		expect(h.settleForReload).not.toHaveBeenCalled();
		expect(h.assign).not.toHaveBeenCalled();
	});

	it('does not reload for a navigation a newer one replaced while it waited', async () => {
		const waits: Array<(ok: boolean) => void> = [];
		const h = await harness({
			settleForReload: vi.fn(() => new Promise<boolean>((resolve) => waits.push(resolve))),
		});
		await h.watch.check();
		const first = h.router.push('/settings');
		await tick();
		const second = h.router.push('/inbox/42');
		await tick();
		waits[0]!(true);
		waits[1]!(true);
		await Promise.all([first, second]);
		expect(h.assign).toHaveBeenCalledTimes(1);
		expect(h.assign).toHaveBeenCalledWith('/inbox/42');
	});

	it('does not reload by itself again after a reload landed on the old build', async () => {
		const h = await harness({ storage: memoryStorage({ [UPDATE_RELOAD_KEY]: NEXT.buildId }) });
		await h.watch.check();
		expect(h.watch.update.value).toEqual(NEXT);
		await h.router.push('/settings');
		expect(h.router.currentRoute.value.path).toBe('/settings');
		expect(h.assign).not.toHaveBeenCalled();

		// The person can still ask for it.
		expect(await h.watch.reloadNow()).toBe('reloading');
		expect(h.reload).toHaveBeenCalledTimes(1);
	});

	it('forgets the mark once a reload landed on the build it was for', async () => {
		const storage = memoryStorage({ [UPDATE_RELOAD_KEY]: BOOT });
		await harness({ storage });
		expect(storage.getItem(UPDATE_RELOAD_KEY)).toBeNull();
	});
});

describe('createAppVersionWatch: the Reload button', () => {
	it('does nothing before an update is known', async () => {
		const h = await harness();
		expect(await h.watch.reloadNow()).toBe('idle');
		expect(h.reload).not.toHaveBeenCalled();
	});

	it('reloads once nothing would be lost, and only once', async () => {
		const h = await harness();
		await h.watch.check();
		expect(await h.watch.reloadNow()).toBe('reloading');
		expect(await h.watch.reloadNow()).toBe('idle');
		expect(h.reload).toHaveBeenCalledTimes(1);
		expect(h.storage.getItem(UPDATE_RELOAD_KEY)).toBe(NEXT.buildId);
	});

	it('leaves the page alone while something would be lost', async () => {
		const h = await harness({ settleForReload: vi.fn(async () => false) });
		await h.watch.check();
		expect(await h.watch.reloadNow()).toBe('blocked');
		expect(h.reload).not.toHaveBeenCalled();
		expect(h.storage.getItem(UPDATE_RELOAD_KEY)).toBeNull();
	});
});
