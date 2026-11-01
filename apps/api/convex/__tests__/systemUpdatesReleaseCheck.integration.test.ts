/**
 * The update check reads GitHub's latest-release answer through a decoder: a
 * release without notes (`body: null`) is still an update, and an answer whose
 * fields have the wrong types is a failed check that keeps the cached result,
 * never a version or notes read off an unchecked value.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	const session = { userId: 'admin-user', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		getMutationContext: vi.fn(async () => session),
		isActiveOrgMember: vi.fn(async () => true),
	};
});

const modules = import.meta.glob('../**/*.*s');

async function platformAdmin() {
	const t = convexTest(schema, modules);
	await t.run((ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId: 'admin-user',
			email: 'admin-user@example.com',
			role: 'admin',
			createdAt: Date.now(),
		})
	);
	return t.withIdentity({ subject: 'admin-user' });
}

function stubRelease(release: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(release), { status: 200 }))
	);
}

beforeEach(() => {
	vi.stubEnv('OWLAT_VERSION', '1.0.0');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('maintenance/releaseCheck.checkForUpdates', () => {
	it('offers a release published without notes', async () => {
		const t = await platformAdmin();
		stubRelease({
			tag_name: 'v1.2.0',
			body: null,
			published_at: '2026-10-01T00:00:00Z',
			draft: false,
			prerelease: false,
		});

		const result = await t.action(api.maintenance.releaseCheck.checkForUpdates, { force: true });

		expect(result).toMatchObject({
			latestVersion: '1.2.0',
			updateAvailable: true,
			releaseNotes: '',
			error: null,
		});
	});

	it.each([
		['a tag that is not text', { tag_name: 120, draft: false }],
		['notes that are not text', { tag_name: 'v1.2.0', body: { text: 'notes' } }],
		['a draft flag that is not a boolean', { tag_name: 'v1.2.0', draft: 'no' }],
	])('fails the check for an answer with %s', async (_label, release) => {
		const t = await platformAdmin();
		stubRelease(release);

		const result = await t.action(api.maintenance.releaseCheck.checkForUpdates, { force: true });

		expect(result.latestVersion).toBeNull();
		expect(result.updateAvailable).toBe(false);
		expect(result.error).toMatch(/unexpected release/);
	});

	describe('the latestCheck cache it writes', () => {
		type Harness = Awaited<ReturnType<typeof platformAdmin>>;
		const latestCheck = (t: Harness) =>
			t.run((ctx) =>
				ctx.db
					.query('systemUpdates')
					.withIndex('by_kind_and_checkedAt', (q) => q.eq('kind', 'latestCheck'))
					.collect()
			);
		const seedCache = (t: Harness, checkedAt: number) =>
			t.run((ctx) =>
				ctx.db.insert('systemUpdates', {
					kind: 'latestCheck',
					latestVersion: '1.1.0',
					releaseNotes: 'old notes',
					publishedAt: 1,
					checkedAt,
				})
			);
		function stubStatus(status: number) {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response('{}', { status }))
			);
		}

		it('caches a stable release on one row', async () => {
			const t = await platformAdmin();
			stubRelease({
				tag_name: 'v1.2.0',
				body: 'notes',
				published_at: '2026-10-01T00:00:00Z',
				draft: false,
				prerelease: false,
			});

			await t.action(api.maintenance.releaseCheck.checkForUpdates, { force: true });
			await t.action(api.maintenance.releaseCheck.checkForUpdates, { force: true });

			const rows = await latestCheck(t);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				latestVersion: '1.2.0',
				releaseNotes: 'notes',
				publishedAt: Date.parse('2026-10-01T00:00:00Z'),
			});
			expect(rows[0]?.error).toBeUndefined();
		});

		it('records a rate limit on the cached row and answers from it', async () => {
			const t = await platformAdmin();
			await seedCache(t, 1);
			stubStatus(429);

			const result = await t.action(api.maintenance.releaseCheck.checkForUpdates, {
				force: true,
			});

			expect(result).toMatchObject({
				latestVersion: '1.1.0',
				updateAvailable: true,
				error: 'rate_limited',
			});
			const [row] = await latestCheck(t);
			expect(row).toMatchObject({ latestVersion: '1.1.0', error: 'rate_limited' });
			expect(row!.checkedAt).toBeGreaterThan(1);
		});

		it('records a failed answer as the check error', async () => {
			const t = await platformAdmin();
			stubStatus(500);

			const result = await t.action(api.maintenance.releaseCheck.checkForUpdates, {
				force: true,
			});

			expect(result.error).toContain('GitHub API returned 500');
			const [row] = await latestCheck(t);
			expect(row?.error).toBe(result.error);
		});

		it('writes nothing for a release it does not offer', async () => {
			const t = await platformAdmin();
			await seedCache(t, 1);
			stubRelease({ tag_name: 'v1.3.0-rc.1', body: 'rc', prerelease: true });

			const result = await t.action(api.maintenance.releaseCheck.checkForUpdates, {
				force: true,
			});

			expect(result).toMatchObject({ latestVersion: '1.1.0', error: null });
			const [row] = await latestCheck(t);
			expect(row).toMatchObject({
				latestVersion: '1.1.0',
				releaseNotes: 'old notes',
				checkedAt: 1,
			});
		});

		it('answers a fresh cache without asking GitHub', async () => {
			const t = await platformAdmin();
			await seedCache(t, Date.now());
			const fetchSpy = vi.fn();
			vi.stubGlobal('fetch', fetchSpy);

			const result = await t.action(api.maintenance.releaseCheck.checkForUpdates, {});

			expect(result.latestVersion).toBe('1.1.0');
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});
});
