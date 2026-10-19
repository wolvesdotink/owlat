import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCanIEmail } from '../useCanIEmail';
import type { CanIEmailData, CanIEmailFeature } from '../../types';

const flexbox: CanIEmailFeature = {
	slug: 'flexbox',
	title: 'Flexbox',
	description: 'CSS flexbox layout',
	url: '',
	category: 'css',
	keywords: 'display flex',
	last_test_date: '',
	test_url: '',
	test_results_url: '',
	notes: '',
	notes_by_num: {},
	stats: {
		gmail: {
			'desktop-webmail': { '1': 'y' },
			'mobile-webmail': { '1': 'a #1' }, // annotated support code
		},
		outlook: {
			windows: { '2016': 'y', '2019': 'n' }, // latest version (2019) wins
		},
	},
};

const grid: CanIEmailFeature = {
	...flexbox,
	slug: 'grid',
	title: 'CSS Grid',
	description: 'Two-dimensional grid layout',
	keywords: 'display grid template',
};

const fixture: CanIEmailData = {
	api_version: '1.0',
	last_update_date: '2026-06-03',
	nicenames: { family: {}, platform: {}, support: {}, category: {} },
	data: [flexbox, grid],
};

describe('useCanIEmail.getFeatureSupport', () => {
	const { getFeatureSupport } = useCanIEmail();

	it('resolves a direct support code', () => {
		expect(getFeatureSupport(flexbox, 'gmail', 'desktop-webmail')).toBe('y');
	});

	it('strips annotations from a support code ("a #1" → "a")', () => {
		expect(getFeatureSupport(flexbox, 'gmail', 'mobile-webmail')).toBe('a');
	});

	it('uses the most recent version when several exist', () => {
		expect(getFeatureSupport(flexbox, 'outlook', 'windows')).toBe('n');
	});

	it('falls back through an array of platform candidates', () => {
		expect(getFeatureSupport(flexbox, 'gmail', ['nope', 'desktop-webmail'])).toBe('y');
	});

	it('returns null for an unknown family or platform', () => {
		expect(getFeatureSupport(flexbox, 'unknown-family', 'x')).toBeNull();
		expect(getFeatureSupport(flexbox, 'gmail', 'unknown-platform')).toBeNull();
	});
});

describe('useCanIEmail data loading + queries', () => {
	// The composable keeps a module-level cache, so each test gets a fresh module
	// instance to avoid cross-test cache bleed.
	async function freshComposable() {
		vi.resetModules();
		const mod = await import('../useCanIEmail');
		return mod.useCanIEmail();
	}

	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, statusText: 'OK', json: async () => fixture })
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('fetchData populates features from the API', async () => {
		const c = await freshComposable();
		await c.fetchData();
		expect(c.features.value.map((f) => f.slug)).toEqual(['flexbox', 'grid']);
		expect(c.error.value).toBeNull();
	});

	it('getFeatureBySlug finds a loaded feature (and misses unknown ones)', async () => {
		const c = await freshComposable();
		await c.fetchData();
		expect(c.getFeatureBySlug('grid')?.title).toBe('CSS Grid');
		expect(c.getFeatureBySlug('nope')).toBeUndefined();
	});

	it('searchFeatures matches title, slug, keywords and description (case-insensitively)', async () => {
		const c = await freshComposable();
		await c.fetchData();
		expect(c.searchFeatures('GRID').map((f) => f.slug)).toEqual(['grid']);
		expect(c.searchFeatures('flex').map((f) => f.slug)).toEqual(['flexbox']);
		// "layout" appears in both descriptions.
		expect(
			c
				.searchFeatures('layout')
				.map((f) => f.slug)
				.sort()
		).toEqual(['flexbox', 'grid']);
		expect(c.searchFeatures('nonexistent-token')).toEqual([]);
	});

	it('serves a second call from the in-memory cache without re-fetching', async () => {
		const c = await freshComposable();
		await c.fetchData();
		await c.fetchData();
		expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it('concurrent callers share one request and all wait for its data', async () => {
		let respond!: () => void;
		const fetchMock = vi.fn(
			() =>
				new Promise((resolve) => {
					respond = () => resolve({ ok: true, statusText: 'OK', json: async () => fixture });
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const c = await freshComposable();

		const settled: string[] = [];
		const first = c.fetchData().then(() => settled.push('first'));
		const second = c.fetchData().then(() => settled.push('second'));
		await Promise.resolve();
		// The second caller joins the load instead of returning before the data.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(settled).toEqual([]);
		expect(c.isLoading.value).toBe(true);

		respond();
		await Promise.all([first, second]);
		expect(settled).toEqual(['first', 'second']);
		expect(c.features.value.map((f) => f.slug)).toEqual(['flexbox', 'grid']);
		expect(c.isLoading.value).toBe(false);
	});

	it('a shared failure settles every caller, and the next call retries', async () => {
		let fail!: () => void;
		const fetchMock = vi.fn(
			() =>
				new Promise((resolve) => {
					fail = () => resolve({ ok: false, statusText: 'Server Error' });
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const c = await freshComposable();

		const callers = Promise.all([c.fetchData(), c.fetchData()]);
		fail();
		await callers;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(c.error.value?.message).toContain('Server Error');
		expect(c.features.value).toEqual([]);

		fetchMock.mockResolvedValueOnce({ ok: true, statusText: 'OK', json: async () => fixture });
		await c.fetchData();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(c.error.value).toBeNull();
		expect(c.features.value.map((f) => f.slug)).toEqual(['flexbox', 'grid']);
	});

	it('records an error (and leaves features empty) when the response is not ok', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, statusText: 'Server Error' }));
		const c = await freshComposable();
		await c.fetchData();
		expect(c.error.value).toBeInstanceOf(Error);
		expect(c.error.value?.message).toContain('Server Error');
		expect(c.features.value).toEqual([]);
	});
});
