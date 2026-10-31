import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { OrganizationRole } from '../../lib/sessionOrganization';
import type * as SessionOrganizationModule from '../../lib/sessionOrganization';

/**
 * The desktop update cache and policy end to end through convex-test:
 *
 *   - `refreshReleases` against a mocked GitHub: which releases are cached,
 *     which manifests are refused, what a rate-limited poll does to the cache,
 *     the prune to 30, and the stable release kept behind release candidates.
 *   - `updatePolicy`: the `settings:manage` gate, and every validation that
 *     stops a policy the cache cannot honour.
 *   - `manifestForClient`: verbatim manifest on a hit, null on a miss.
 *
 * The auth floor is mocked (the wrappers are covered by their own suite) but the
 * ROLE → PERMISSION map is the real one, so the editor rejection is a genuine
 * end-to-end check of the gate this module chose.
 */

let mockRole: OrganizationRole = 'owner';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
			activeOrganizationId: 'org-1',
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
			activeOrganizationId: 'org-1',
		})),
		// Run the REAL role→permission map against the mocked role so the
		// `checkNow` probe's rejection is exercised, not stubbed away.
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				// The explicit annotation is what lets TS narrow through
				// `requirePermission`'s assertion signature off a property access.
				const mod: typeof SessionOrganizationModule = actual;
				mod.requirePermission(
					mod.hasPermission(
						mockRole as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1]
					),
					message
				);
				return { userId: 'test-user', role: mockRole, activeOrganizationId: 'org-1' };
			}),
	};
});

// Vite canonicalizes glob keys for files in this same subtree: a sibling at
// convex/desktop/X is keyed as '../X' rather than '../../desktop/X', which
// convex-test's '../../_generated/...'-derived prefix would never match.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../desktop/' + key.slice(3), val]
			: [key, val]
	)
);

// ── GitHub fixtures ──────────────────────────────────────────────────────────

const PUBLISHED = '2026-09-10T08:00:00Z';

function githubRelease(
	tag: string,
	extra: { draft?: boolean; prerelease?: boolean; body?: string; published_at?: string } = {}
) {
	return { tag_name: tag, published_at: PUBLISHED, body: extra.body ?? 'notes', ...extra };
}

function manifestFor(version: string, url = 'https://github.com/wolvesdotink/owlat/x.AppImage') {
	return JSON.stringify({
		version,
		pub_date: PUBLISHED,
		platforms: {
			'linux-x86_64': { url, signature: 'sig' },
			'darwin-universal': { url, signature: 'sig' },
		},
	});
}

interface FetchPlan {
	releases?: unknown;
	releasesStatus?: number;
	/** The listing page by page (`&page=N` serves `pages[N-1]`); overrides `releases`. */
	pages?: unknown[][];
	/** Keyed by page number: a status other than 200 for that page. */
	pageStatus?: Record<number, number>;
	/** Keyed by tag: the body served for that tag's `latest.json`, or null for 404. */
	manifests?: Record<string, string | null>;
}

function stubFetch(plan: FetchPlan) {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string) => {
			calls.push(input);
			if (input.startsWith('https://api.github.com/')) {
				const page = Number(new URL(input).searchParams.get('page') ?? '1');
				const status = plan.pageStatus?.[page] ?? plan.releasesStatus ?? 200;
				return {
					ok: status >= 200 && status < 300,
					status,
					json: async () => (plan.pages ? (plan.pages[page - 1] ?? []) : (plan.releases ?? [])),
				};
			}
			const tag = input.split('/download/')[1]?.split('/')[0] ?? '';
			const body = plan.manifests?.[tag];
			if (body === undefined || body === null)
				return { ok: false, status: 404, text: async () => '' };
			return { ok: true, status: 200, text: async () => body };
		})
	);
	return calls;
}

beforeEach(() => {
	mockRole = 'owner';
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** One schema-typed harness per test, so the helpers below see the tables. */
function harness() {
	return convexTest(schema, modules);
}
type TestHarness = ReturnType<typeof harness>;

async function cachedReleases(t: TestHarness) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_version', (q) => q.eq('kind', 'release'))
			.collect()
	);
}

async function checkState(t: TestHarness) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('desktopReleases')
			.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
			.first()
	);
}

// ── refreshReleases ──────────────────────────────────────────────────────────

describe('desktop.updates.refreshReleases', () => {
	it('caches both desktop-bearing release lines with their manifests verbatim', async () => {
		const t = harness();
		const manifest = manifestFor('0.4.7');
		stubFetch({
			releases: [githubRelease('v0.4.6'), githubRelease('desktop-v0.4.7')],
			manifests: { 'v0.4.6': manifestFor('0.4.6'), 'desktop-v0.4.7': manifest },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		const rows = await cachedReleases(t);
		expect(rows.map((row) => row.version).sort()).toEqual(['0.4.6', '0.4.7']);
		const desktopRow = rows.find((row) => row.version === '0.4.7');
		expect(desktopRow?.line).toBe('desktop');
		expect(desktopRow?.manifest).toBe(manifest);
		expect(desktopRow?.isPrerelease).toBe(false);
		const state = await checkState(t);
		expect(state?.error).toBeUndefined();
		expect(typeof state?.checkedAt).toBe('number');
	});

	it('skips drafts, server-only releases and unrelated tags', async () => {
		const t = harness();
		stubFetch({
			releases: [
				githubRelease('v0.4.8', { draft: true }),
				githubRelease('server-v0.4.6'),
				githubRelease('nightly'),
				githubRelease('v0.4.5'), // published, but has no latest.json asset
			],
			manifests: { 'v0.4.8': manifestFor('0.4.8') },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(await cachedReleases(t)).toHaveLength(0);
	});

	it('marks an rc tag as a pre-release even when GitHub does not', async () => {
		const t = harness();
		stubFetch({
			releases: [githubRelease('v0.5.0-rc.1')],
			manifests: { 'v0.5.0-rc.1': manifestFor('0.5.0-rc.1') },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		const [row] = await cachedReleases(t);
		expect(row?.isPrerelease).toBe(true);
	});

	it('refuses a manifest whose version does not match its tag', async () => {
		const t = harness();
		stubFetch({
			releases: [githubRelease('v0.4.6')],
			manifests: { 'v0.4.6': manifestFor('9.9.9') },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(await cachedReleases(t)).toHaveLength(0);
	});

	it('refuses a manifest whose bundle URL host is off the allow-list', async () => {
		const t = harness();
		stubFetch({
			releases: [githubRelease('v0.4.6')],
			manifests: { 'v0.4.6': manifestFor('0.4.6', 'https://evil.example.com/owlat.AppImage') },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(await cachedReleases(t)).toHaveLength(0);
	});

	it('records rate_limited and leaves the cache untouched', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('desktopReleases', {
				kind: 'release',
				tag: 'v0.4.6',
				version: '0.4.6',
				line: 'unified',
				isPrerelease: false,
				publishedAt: Date.parse(PUBLISHED),
				manifest: manifestFor('0.4.6'),
				fetchedAt: Date.now(),
			});
		});
		stubFetch({ releasesStatus: 429 });

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(await cachedReleases(t)).toHaveLength(1);
		expect((await checkState(t))?.error).toBe('rate_limited');
	});

	it('records the failure when GitHub is unreachable', async () => {
		const t = harness();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect((await checkState(t))?.error).toBe('network down');
	});

	it('keeps what it cached before a failure partway through, and records the failure', async () => {
		const t = harness();
		stubFetch({
			releases: [githubRelease('v0.4.7'), githubRelease('v0.4.6')],
			manifests: { 'v0.4.7': manifestFor('0.4.7') },
		});
		const listed = vi.mocked(fetch).getMockImplementation()!;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string) => {
				if (input.includes('/v0.4.6/')) throw new Error('connection reset');
				return listed(input);
			})
		);

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect((await cachedReleases(t)).map((row) => row.version)).toEqual(['0.4.7']);
		expect((await checkState(t))?.error).toBe('connection reset');
	});

	it('does not re-download a manifest it has already cached', async () => {
		const t = harness();
		const plan = {
			releases: [githubRelease('v0.4.6')],
			manifests: { 'v0.4.6': manifestFor('0.4.6') },
		};
		stubFetch(plan);
		await t.action(internal.desktop.updates.refreshReleases, {});

		const calls = stubFetch(plan);
		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(calls.filter((url) => url.includes('latest.json'))).toHaveLength(0);
		expect(await cachedReleases(t)).toHaveLength(1);
	});

	it('keeps a desktop hot-fix and a unified release of the same version side by side', async () => {
		// `desktop-v0.4.7` cut one patch above main, then `release:cut patch` on
		// main produces `v0.4.7`: two signed bundles, one version. A cache keyed
		// by version made them overwrite each other on alternate refreshes.
		const t = harness();
		const desktopManifest = manifestFor(
			'0.4.7',
			'https://github.com/wolvesdotink/owlat/d.AppImage'
		);
		const unifiedManifest = manifestFor(
			'0.4.7',
			'https://github.com/wolvesdotink/owlat/u.AppImage'
		);
		stubFetch({
			releases: [githubRelease('desktop-v0.4.7')],
			manifests: { 'desktop-v0.4.7': desktopManifest },
		});
		await t.action(internal.desktop.updates.refreshReleases, {});

		const both = {
			releases: [githubRelease('v0.4.7'), githubRelease('desktop-v0.4.7')],
			manifests: { 'v0.4.7': unifiedManifest, 'desktop-v0.4.7': desktopManifest },
		};
		stubFetch(both);
		await t.action(internal.desktop.updates.refreshReleases, {});
		const calls = stubFetch(both);
		await t.action(internal.desktop.updates.refreshReleases, {});

		const rows = await cachedReleases(t);
		expect(rows.map((row) => row.tag).sort()).toEqual(['desktop-v0.4.7', 'v0.4.7']);
		// Nothing left to fetch on the third pass: both tags are known.
		expect(calls.filter((url) => url.includes('latest.json'))).toHaveLength(0);

		// Clients get the unified bundle for 0.4.7, on every check.
		const served = await t.query(api.desktop.updates.manifestForClient, {
			target: 'linux',
			arch: 'x86_64',
			currentVersion: '0.4.6',
		});
		expect(served).toEqual({ manifest: unifiedManifest, version: '0.4.7' });
		expect((await t.query(api.desktop.updates.getPolicySummary, {})).latestVersion).toBe('0.4.7');
	});

	it('prunes the cache to the newest 30 releases', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			for (let i = 0; i < 35; i++) {
				await ctx.db.insert('desktopReleases', {
					kind: 'release',
					tag: `v0.1.${i}`,
					version: `0.1.${i}`,
					line: 'unified',
					isPrerelease: false,
					publishedAt: Date.parse(PUBLISHED) + i * 1000,
					manifest: manifestFor(`0.1.${i}`),
					fetchedAt: Date.now(),
				});
			}
		});
		stubFetch({ releases: [] });

		await t.action(internal.desktop.updates.refreshReleases, {});

		const rows = await cachedReleases(t);
		expect(rows).toHaveLength(30);
		// The five oldest went; the newest survived.
		expect(rows.some((row) => row.version === '0.1.0')).toBe(false);
		expect(rows.some((row) => row.version === '0.1.34')).toBe(true);
	});
});

// ── stable releases behind release candidates ────────────────────────────────

describe('desktop.updates stable release behind release candidates', () => {
	/** `count` candidates of 0.7.0, newest first, each a minute newer than the last. */
	function candidateReleases(count: number, from = 1) {
		return Array.from({ length: count }, (_, i) => {
			const n = from + count - 1 - i;
			return githubRelease(`v0.7.0-rc.${n}`, {
				prerelease: true,
				published_at: new Date(Date.parse(PUBLISHED) + (24 * 60 + n) * 60_000).toISOString(),
			});
		});
	}

	function candidateManifests(count: number, from = 1) {
		return Object.fromEntries(
			Array.from({ length: count }, (_, i) => [
				`v0.7.0-rc.${from + i}`,
				manifestFor(`0.7.0-rc.${from + i}`),
			])
		);
	}

	const stableManifests = {
		'v0.6.15': manifestFor('0.6.15'),
		'v0.6.16': manifestFor('0.6.16'),
	};

	async function servedTo(t: TestHarness, currentVersion: string) {
		return await t.query(api.desktop.updates.manifestForClient, {
			target: 'linux',
			arch: 'x86_64',
			currentVersion,
		});
	}

	const listingCalls = (calls: string[]) =>
		calls.filter((url) => url.startsWith('https://api.github.com/'));

	it('keeps serving the stable release while candidates are refreshed in one by one', async () => {
		const t = harness();
		stubFetch({ releases: [githubRelease('v0.6.16')], manifests: stableManifests });
		await t.action(internal.desktop.updates.refreshReleases, {});
		expect((await servedTo(t, '0.6.15'))?.version).toBe('0.6.16');

		// Each candidate is published and refreshed on its own, so 0.6.16 slides
		// off the first listing page while the cache already holds it.
		const LIMIT = 30;
		for (let n = 1; n <= LIMIT + 1; n++) {
			const listing = [...candidateReleases(n), githubRelease('v0.6.16')];
			stubFetch({
				pages: [listing.slice(0, LIMIT), listing.slice(LIMIT)],
				manifests: { ...stableManifests, ...candidateManifests(n) },
			});
			await t.action(internal.desktop.updates.refreshReleases, {});
		}

		const versions = (await cachedReleases(t)).map((row) => row.version);
		// The newest thirty candidates are the rolling cache; 0.6.16 rides on top.
		expect(versions).toHaveLength(LIMIT + 1);
		expect(versions).toContain('0.6.16');
		expect(versions).not.toContain('0.7.0-rc.1');
		expect((await servedTo(t, '0.6.15'))?.version).toBe('0.6.16');
		const summary = await t.query(api.desktop.updates.getPolicySummary, {});
		expect(summary.latestVersion).toBe('0.6.16');
	});

	it('finds the stable release past a full page of candidates on a fresh cache', async () => {
		const t = harness();
		const calls = stubFetch({
			pages: [
				candidateReleases(30, 5),
				[...candidateReleases(4), githubRelease('v0.6.16'), githubRelease('v0.6.15')],
			],
			manifests: { ...stableManifests, ...candidateManifests(34) },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		const versions = (await cachedReleases(t)).map((row) => row.version);
		// The first page whole, then only the stable release from the second.
		expect(versions).toHaveLength(31);
		expect(versions).toContain('0.6.16');
		expect(versions).not.toContain('0.6.15');
		expect(versions).not.toContain('0.7.0-rc.4');
		expect(listingCalls(calls)).toHaveLength(2);
		expect((await servedTo(t, '0.6.15'))?.version).toBe('0.6.16');
		expect((await checkState(t))?.error).toBeUndefined();
	});

	it('reads one listing page when the stable release is on it', async () => {
		const t = harness();
		const calls = stubFetch({
			pages: [[...candidateReleases(29), githubRelease('v0.6.16')], [githubRelease('v0.6.15')]],
			manifests: { ...stableManifests, ...candidateManifests(29) },
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(listingCalls(calls)).toHaveLength(1);
		expect((await servedTo(t, '0.6.15'))?.version).toBe('0.6.16');
	});

	it('stops at the page budget when no stable release is listed', async () => {
		const t = harness();
		const pages = Array.from({ length: 12 }, (_, i) => candidateReleases(30, 1000 - 30 * (i + 1)));
		const calls = stubFetch({ pages, manifests: candidateManifests(30, 970) });

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(listingCalls(calls)).toHaveLength(10);
		// Candidates past the first page are never downloaded.
		expect(calls.filter((url) => url.includes('latest.json'))).toHaveLength(30);
		expect(await cachedReleases(t)).toHaveLength(30);
	});

	describe('under a defer window, with a desktop hot-fix of the deferred version', () => {
		// v0.6.16 (12 h old) is inside a 24-hour window; desktop-v0.6.16 (48 h)
		// is past it but loses to the unified row of its version, so a stable
		// client is served 0.6.15 (72 h). Times are relative to the clock at
		// the start of the test; no test waits on it.
		function stableListing(now: number) {
			const hoursAgo = (hours: number) => new Date(now - hours * 3600_000).toISOString();
			return [
				githubRelease('v0.6.16', { published_at: hoursAgo(12) }),
				githubRelease('desktop-v0.6.16', { published_at: hoursAgo(48) }),
				githubRelease('v0.6.15', { published_at: hoursAgo(72) }),
			];
		}
		/** Thirty candidates, all newer than the stable releases. */
		function newerCandidates(now: number) {
			return Array.from({ length: 30 }, (_, i) =>
				githubRelease(`v0.7.0-rc.${30 - i}`, {
					prerelease: true,
					published_at: new Date(now - (i + 1) * 60_000).toISOString(),
				})
			);
		}
		const manifests = {
			...stableManifests,
			'desktop-v0.6.16': manifestFor('0.6.16'),
			...candidateManifests(30),
		};

		async function deferBy24Hours(t: TestHarness) {
			await t.mutation(api.desktop.updates.updatePolicy, {
				mode: 'latest',
				channel: 'stable',
				deferHours: 24,
			});
		}

		it('keeps the served release when candidates push it off the rolling cache', async () => {
			const t = harness();
			const now = Date.now();
			await deferBy24Hours(t);
			stubFetch({ releases: stableListing(now), manifests });
			await t.action(internal.desktop.updates.refreshReleases, {});
			expect((await servedTo(t, '0.6.14'))?.version).toBe('0.6.15');

			stubFetch({ pages: [newerCandidates(now), stableListing(now)], manifests });
			await t.action(internal.desktop.updates.refreshReleases, {});

			const tags = (await cachedReleases(t)).map((row) => row.tag);
			expect(tags).toContain('v0.6.15');
			expect(tags).toContain('v0.6.16');
			expect(tags).toContain('desktop-v0.6.16');
			expect((await servedTo(t, '0.6.14'))?.version).toBe('0.6.15');
		});

		it('walks on to the served release on a fresh cache', async () => {
			const t = harness();
			const now = Date.now();
			await deferBy24Hours(t);
			stubFetch({ pages: [newerCandidates(now), stableListing(now)], manifests });

			await t.action(internal.desktop.updates.refreshReleases, {});

			const tags = (await cachedReleases(t)).map((row) => row.tag);
			// The desktop row cannot change what 0.6.16 serves, so it is skipped.
			expect(tags).toContain('v0.6.16');
			expect(tags).toContain('v0.6.15');
			expect(tags).not.toContain('desktop-v0.6.16');
			expect(tags).toHaveLength(32);
			expect((await servedTo(t, '0.6.14'))?.version).toBe('0.6.15');
		});
	});

	it('keeps the first page and records the error when a later page fails', async () => {
		const t = harness();
		stubFetch({
			pages: [candidateReleases(30)],
			pageStatus: { 2: 429 },
			manifests: candidateManifests(30),
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(await cachedReleases(t)).toHaveLength(30);
		expect((await checkState(t))?.error).toBe('rate_limited');
	});
});

// ── pinned release retention ─────────────────────────────────────────────────

describe('desktop.updates pinned release retention', () => {
	interface SeedRow {
		version: string;
		/** Hours after PUBLISHED; higher is newer. */
		hour: number;
		line?: 'unified' | 'desktop';
		isPrerelease?: boolean;
	}

	async function seedRows(t: TestHarness, rows: SeedRow[]) {
		await t.run(async (ctx) => {
			for (const row of rows) {
				const line = row.line ?? 'unified';
				await ctx.db.insert('desktopReleases', {
					kind: 'release',
					tag: `${line === 'desktop' ? 'desktop-' : ''}v${row.version}`,
					version: row.version,
					line,
					isPrerelease: row.isPrerelease ?? false,
					publishedAt: Date.parse(PUBLISHED) + row.hour * 3600_000,
					manifest: manifestFor(
						row.version,
						`https://github.com/wolvesdotink/owlat/${line}.AppImage`
					),
					fetchedAt: Date.now(),
				});
			}
		});
	}

	/** 0.2.0 … 0.2.<count-1>, each an hour newer than the last, all after hour 0. */
	function rolling(count: number): SeedRow[] {
		return Array.from({ length: count }, (_, i) => ({ version: `0.2.${i}`, hour: i + 1 }));
	}

	async function servedTo(t: TestHarness, currentVersion: string) {
		return await t.query(api.desktop.updates.manifestForClient, {
			target: 'linux',
			arch: 'x86_64',
			currentVersion,
		});
	}

	async function refresh(t: TestHarness) {
		stubFetch({ releases: [] });
		await t.action(internal.desktop.updates.refreshReleases, {});
	}

	it('keeps a pinned release the rolling cache has outgrown, and keeps serving it', async () => {
		const t = harness();
		await seedRows(t, [{ version: '0.1.0', hour: 0 }, ...rolling(32)]);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.1.0',
		});
		expect((await servedTo(t, '0.0.9'))?.version).toBe('0.1.0');

		await refresh(t);

		const versions = (await cachedReleases(t)).map((row) => row.version);
		// The newest thirty are the rolling working set, the pin rides on top.
		expect(versions).toHaveLength(31);
		expect(versions).toContain('0.1.0');
		expect(versions).not.toContain('0.2.0');
		expect(versions).not.toContain('0.2.1');
		expect(versions).toContain('0.2.31');
		expect(await servedTo(t, '0.0.9')).toEqual({
			manifest: manifestFor('0.1.0', 'https://github.com/wolvesdotink/owlat/unified.AppImage'),
			version: '0.1.0',
		});
		expect((await t.query(api.desktop.updates.getPolicy, {})).pinCached).toBe(true);
		// The admin list still offers it, so the saved pin stays re-savable.
		const listed = await t.query(api.desktop.updates.listReleases, {});
		expect(listed.map((release) => release.version)).toContain('0.1.0');
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.1.0',
		});
	});

	it('lets the formerly pinned release age out once the pin moves on', async () => {
		const t = harness();
		await seedRows(t, [{ version: '0.1.0', hour: 0 }, ...rolling(32)]);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.1.0',
		});
		await refresh(t);
		expect((await cachedReleases(t)).map((row) => row.version)).toContain('0.1.0');

		// Re-pinned to a release inside the rolling cache: 0.1.0 is just old now.
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.2.10',
		});
		await refresh(t);
		let versions = (await cachedReleases(t)).map((row) => row.version);
		expect(versions).toHaveLength(30);
		expect(versions).not.toContain('0.1.0');

		// Unpinned entirely: the cache is the plain newest thirty again.
		await t.mutation(api.desktop.updates.updatePolicy, { mode: 'latest', channel: 'stable' });
		await seedRows(t, [{ version: '0.2.40', hour: 40 }]);
		await refresh(t);
		versions = (await cachedReleases(t)).map((row) => row.version);
		expect(versions).toHaveLength(30);
		expect(versions).toContain('0.2.40');
		expect(versions).not.toContain('0.2.2');
		expect((await t.query(api.desktop.updates.getPolicy, {})).pinCached).toBeNull();
	});

	it('keeps both release lines of a pinned version and serves the unified one', async () => {
		const t = harness();
		await seedRows(t, [
			{ version: '0.1.0', hour: 0, line: 'desktop' },
			{ version: '0.1.0', hour: 0 },
			...rolling(31),
		]);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.1.0',
		});

		await refresh(t);

		const pinned = (await cachedReleases(t)).filter((row) => row.version === '0.1.0');
		expect(pinned.map((row) => row.line).sort()).toEqual(['desktop', 'unified']);
		expect((await servedTo(t, '0.0.9'))?.manifest).toBe(
			manifestFor('0.1.0', 'https://github.com/wolvesdotink/owlat/unified.AppImage')
		);
	});

	it('keeps a pinned pre-release on the pre-release channel', async () => {
		const t = harness();
		await seedRows(t, [{ version: '0.1.0-rc.1', hour: 0, isPrerelease: true }, ...rolling(31)]);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'prerelease',
			pinnedVersion: '0.1.0-rc.1',
		});

		await refresh(t);

		expect((await cachedReleases(t)).map((row) => row.version)).toContain('0.1.0-rc.1');
		expect((await servedTo(t, '0.0.9'))?.version).toBe('0.1.0-rc.1');
	});

	it('serves the pin even when it sorts past what one bounded read covers', async () => {
		// More rows than a single read takes (a refresh that died before its
		// prune, say), and the pin is last in the index's version-string order.
		const t = harness();
		await seedRows(t, [
			{ version: '0.9.0', hour: 0 },
			...Array.from({ length: 70 }, (_, i) => ({ version: `0.1.${i}`, hour: i + 1 })),
		]);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.9.0',
		});

		expect((await servedTo(t, '0.0.9'))?.version).toBe('0.9.0');
		const listed = await t.query(api.desktop.updates.listReleases, {});
		expect(listed[0]?.version).toBe('0.9.0');
	});

	it('still knows every tag it holds, so a retained pin is not re-downloaded', async () => {
		const t = harness();
		const seeded = [{ version: '0.1.0', hour: 0 }, ...rolling(30)];
		await seedRows(t, seeded);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.1.0',
		});
		const calls = stubFetch({
			releases: seeded.map((row) => githubRelease(`v${row.version}`)),
			manifests: Object.fromEntries(
				seeded.map((row) => [`v${row.version}`, manifestFor(row.version)])
			),
		});

		await t.action(internal.desktop.updates.refreshReleases, {});

		expect(calls.filter((url) => url.includes('latest.json'))).toHaveLength(0);
		expect(await cachedReleases(t)).toHaveLength(31);
	});

	it('tells the admin page when the pinned release is no longer cached', async () => {
		// A pin the cache lost before pinned rows were exempt from the prune.
		const t = harness();
		await seedRows(t, [{ version: '0.1.0', hour: 0 }]);
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.1.0',
		});
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('desktopReleases').collect()) {
				await ctx.db.delete(row._id);
			}
		});

		expect((await t.query(api.desktop.updates.getPolicy, {})).pinCached).toBe(false);
		expect(await servedTo(t, '0.0.9')).toBeNull();
	});
});

// ── manifestForClient ────────────────────────────────────────────────────────

describe('desktop.updates.manifestForClient', () => {
	async function seed(t: TestHarness, versions: string[]) {
		await t.run(async (ctx) => {
			for (const version of versions) {
				await ctx.db.insert('desktopReleases', {
					kind: 'release',
					tag: `v${version}`,
					version,
					line: 'unified',
					isPrerelease: false,
					publishedAt: Date.parse(PUBLISHED),
					manifest: manifestFor(version),
					fetchedAt: Date.now(),
				});
			}
		});
	}

	it('returns the cached manifest verbatim for an out-of-date client', async () => {
		const t = harness();
		await seed(t, ['0.4.6', '0.4.7']);

		const result = await t.query(api.desktop.updates.manifestForClient, {
			target: 'darwin',
			arch: 'aarch64',
			currentVersion: '0.4.6',
		});

		expect(result).toEqual({ manifest: manifestFor('0.4.7'), version: '0.4.7' });
	});

	it('returns null for a client that is already current', async () => {
		const t = harness();
		await seed(t, ['0.4.6']);

		expect(
			await t.query(api.desktop.updates.manifestForClient, {
				target: 'linux',
				arch: 'x86_64',
				currentVersion: '0.4.6',
			})
		).toBeNull();
	});

	it('returns null while the policy is paused', async () => {
		const t = harness();
		await seed(t, ['0.4.7']);
		await t.mutation(api.desktop.updates.updatePolicy, { mode: 'paused', channel: 'stable' });

		expect(
			await t.query(api.desktop.updates.manifestForClient, {
				target: 'linux',
				arch: 'x86_64',
				currentVersion: '0.4.6',
			})
		).toBeNull();
	});
});

// ── policy reads + writes ────────────────────────────────────────────────────

describe('desktop.updates.updatePolicy', () => {
	it('rejects an editor with the settings:manage error', async () => {
		const t = harness();
		mockRole = 'editor';

		await expect(
			t.mutation(api.desktop.updates.updatePolicy, { mode: 'paused', channel: 'stable' })
		).rejects.toThrow(/owners and admins/);
	});

	it('stores the policy with its audit stamp and reads it back', async () => {
		const t = harness();
		mockRole = 'admin';

		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'latest',
			channel: 'prerelease',
			deferHours: 24,
			requiredVersion: '0.4.0',
		});

		const { policy } = await t.query(api.desktop.updates.getPolicy, {});
		expect(policy).toMatchObject({
			mode: 'latest',
			channel: 'prerelease',
			deferHours: 24,
			requiredVersion: '0.4.0',
		});
		const stored = await t.run(async (ctx) => ctx.db.query('instanceSettings').first());
		expect(stored?.desktopUpdates?.updatedBy).toBe('test-user');
		expect(typeof stored?.desktopUpdates?.updatedAt).toBe('number');
		const audit = await t.run(async (ctx) => ctx.db.query('auditLogs').collect());
		expect(audit).toHaveLength(1);
		expect(audit[0]?.action).toBe('settings.updated');
	});

	it('resolves who last changed the policy for the admin page audit line', async () => {
		const t = harness();
		mockRole = 'admin';
		await t.run(async (ctx) => {
			await ctx.db.insert('userProfiles', {
				authUserId: 'test-user',
				email: 'marcel@example.com',
				name: 'Marcel',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		expect((await t.query(api.desktop.updates.getPolicy, {})).lastChange).toBeNull();

		await t.mutation(api.desktop.updates.updatePolicy, { mode: 'paused', channel: 'stable' });

		const { lastChange } = await t.query(api.desktop.updates.getPolicy, {});
		expect(lastChange?.by).toBe('Marcel');
		expect(typeof lastChange?.at).toBe('number');
	});

	it('refuses a pin to a version nothing has cached', async () => {
		const t = harness();

		await expect(
			t.mutation(api.desktop.updates.updatePolicy, {
				mode: 'pinned',
				channel: 'stable',
				pinnedVersion: '9.9.9',
			})
		).rejects.toThrow(/No cached desktop release/);
	});

	it('refuses pinning with no version at all', async () => {
		const t = harness();

		await expect(
			t.mutation(api.desktop.updates.updatePolicy, { mode: 'pinned', channel: 'stable' })
		).rejects.toThrow(/needs a version/);
	});

	it('accepts a pin to a cached version', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('desktopReleases', {
				kind: 'release',
				tag: 'v0.4.6',
				version: '0.4.6',
				line: 'unified',
				isPrerelease: false,
				publishedAt: Date.parse(PUBLISHED),
				manifest: manifestFor('0.4.6'),
				fetchedAt: Date.now(),
			});
		});

		const saved = await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'stable',
			pinnedVersion: '0.4.6',
		});
		expect(saved.pinnedVersion).toBe('0.4.6');
	});

	it('refuses a pre-release pin on the stable channel', async () => {
		// The resolver hides pre-releases on `stable` before it looks for the pin,
		// so this policy would answer 204 to every client while claiming a pin.
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('desktopReleases', {
				kind: 'release',
				tag: 'v0.5.0-rc.1',
				version: '0.5.0-rc.1',
				line: 'unified',
				isPrerelease: true,
				publishedAt: Date.parse(PUBLISHED),
				manifest: manifestFor('0.5.0-rc.1'),
				fetchedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.desktop.updates.updatePolicy, {
				mode: 'pinned',
				channel: 'stable',
				pinnedVersion: '0.5.0-rc.1',
			})
		).rejects.toThrow(/prerelease channel/);

		const saved = await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'pinned',
			channel: 'prerelease',
			pinnedVersion: '0.5.0-rc.1',
		});
		expect(saved.pinnedVersion).toBe('0.5.0-rc.1');
	});

	it('bounds the defer window to 0..168 whole hours', async () => {
		const t = harness();

		for (const deferHours of [-1, 169, 1.5]) {
			await expect(
				t.mutation(api.desktop.updates.updatePolicy, {
					mode: 'latest',
					channel: 'stable',
					deferHours,
				})
			).rejects.toThrow(/defer window/);
		}
		await t.mutation(api.desktop.updates.updatePolicy, {
			mode: 'latest',
			channel: 'stable',
			deferHours: 168,
		});
	});

	it('refuses a required version that is not semver', async () => {
		const t = harness();

		await expect(
			t.mutation(api.desktop.updates.updatePolicy, {
				mode: 'latest',
				channel: 'stable',
				requiredVersion: 'latest',
			})
		).rejects.toThrow(/semver/);
	});
});

describe('desktop.updates reads', () => {
	it('summarises the default policy for an anonymous client', async () => {
		const t = harness();

		expect(await t.query(api.desktop.updates.getPolicySummary, {})).toEqual({
			mode: 'latest',
			channel: 'stable',
			pinnedVersion: null,
			requiredVersion: null,
			deferHours: 0,
			latestVersion: null,
			latestPublishedAt: null,
			hasCachedReleases: false,
			checkedAt: null,
		});
	});

	it('reports a cache that holds nothing on the stable channel as non-empty', async () => {
		// The app goes around an instance only when it has cached nothing at all;
		// "nothing on this channel" is the instance's answer, not a gap.
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('desktopReleases', {
				kind: 'release',
				tag: 'v0.5.0-rc.1',
				version: '0.5.0-rc.1',
				line: 'unified',
				isPrerelease: true,
				publishedAt: Date.parse(PUBLISHED),
				manifest: manifestFor('0.5.0-rc.1'),
				fetchedAt: Date.now(),
			});
		});

		const summary = await t.query(api.desktop.updates.getPolicySummary, {});
		expect(summary.latestVersion).toBeNull();
		expect(summary.hasCachedReleases).toBe(true);
	});

	it('refuses the cached-release list to an editor', async () => {
		const t = harness();
		mockRole = 'editor';

		await expect(t.query(api.desktop.updates.listReleases, {})).rejects.toThrow(
			/owners and admins/
		);
	});
});

describe('desktop.updates.checkNow', () => {
	it('refuses an editor before touching GitHub', async () => {
		const t = harness();
		mockRole = 'editor';
		const calls = stubFetch({ releases: [] });

		await expect(t.action(api.desktop.updates.checkNow, {})).rejects.toThrow(/owners and admins/);
		expect(calls).toHaveLength(0);
	});

	it('refreshes and returns the check state for an admin', async () => {
		const t = harness();
		mockRole = 'admin';
		stubFetch({
			releases: [githubRelease('v0.4.6')],
			manifests: { 'v0.4.6': manifestFor('0.4.6') },
		});

		const state = await t.action(api.desktop.updates.checkNow, {});

		expect(state.error).toBeNull();
		expect(typeof state.checkedAt).toBe('number');
		expect(await cachedReleases(t)).toHaveLength(1);
	});
});
