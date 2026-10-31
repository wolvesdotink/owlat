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

describe('systemUpdatesReleaseCheck.checkForUpdates', () => {
	it('offers a release published without notes', async () => {
		const t = await platformAdmin();
		stubRelease({
			tag_name: 'v1.2.0',
			body: null,
			published_at: '2026-10-01T00:00:00Z',
			draft: false,
			prerelease: false,
		});

		const result = await t.action(api.systemUpdatesReleaseCheck.checkForUpdates, { force: true });

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

		const result = await t.action(api.systemUpdatesReleaseCheck.checkForUpdates, { force: true });

		expect(result.latestVersion).toBeNull();
		expect(result.updateAvailable).toBe(false);
		expect(result.error).toMatch(/unexpected release/);
	});
});
