import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';

// The audience-dashboard analytics are `authedQuery`s gated on
// `requireOrgMember`; stub it so they run as an authenticated org member
// without a full BetterAuth session.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `contacts/__tests__` file
// omits the sibling `contacts/*` modules (including `contacts/analytics.ts`, the
// module under test). Merge a second glob rooted at `contacts/` and re-prefix its
// keys to the same `../../`-relative form so convex-test's single module-root
// prefix resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const contactsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../contacts/'),
		mod,
	])
);
const modules = { ...rootGlob, ...contactsGlob };

async function insertContact(
	t: ReturnType<typeof convexTest>,
	createdAt: number
): Promise<Id<'contacts'>> {
	return t.run((ctx) =>
		ctx.db.insert('contacts', {
			email: `c-${createdAt}-${Math.random()}@example.com`,
			source: 'api',
			doiStatus: 'not_required',
			createdAt,
			updatedAt: createdAt,
		})
	);
}

describe('contacts.analytics.getSubscriberGrowth — bounded scan', () => {
	it('returns a { days, truncated } series without unbounded-collecting', async () => {
		const t = convexTest(schema, modules);

		const now = Date.now();
		const oneDay = 24 * 60 * 60 * 1000;
		// Three contacts created within the last 30 days.
		await insertContact(t, now - oneDay);
		await insertContact(t, now - oneDay);
		await insertContact(t, now - 2 * oneDay);
		// One contact outside the 30-day window must not be counted.
		await insertContact(t, now - 40 * oneDay);

		const result = await t.query(api.contacts.analytics.getSubscriberGrowth, {});

		// New object shape: a 30-entry day series plus a truncation flag.
		expect(result.truncated).toBe(false);
		expect(result.days).toHaveLength(30);
		const total = result.days.reduce((sum, day) => sum + day.count, 0);
		expect(total).toBe(3);
	});

	it('excludes soft-deleted (GDPR-erased) contacts from the growth series', async () => {
		const t = convexTest(schema, modules);

		const now = Date.now();
		const oneDay = 24 * 60 * 60 * 1000;
		// Two live contacts in-window and one soft-deleted contact in-window.
		await insertContact(t, now - oneDay);
		await insertContact(t, now - 2 * oneDay);
		await t.run((ctx) =>
			ctx.db.insert('contacts', {
				email: `erased-${Math.random()}@example.com`,
				source: 'api',
				doiStatus: 'not_required',
				deletedAt: now,
				createdAt: now - oneDay,
				updatedAt: now,
			})
		);

		const result = await t.query(api.contacts.analytics.getSubscriberGrowth, {});
		const total = result.days.reduce((sum, day) => sum + day.count, 0);
		// The erased contact must not inflate the count.
		expect(total).toBe(2);
	});
});

describe('contacts.analytics.getRecent — redaction, soft-delete, clamp', () => {
	it('never leaks DOI capability fields and excludes soft-deleted contacts', async () => {
		const t = convexTest(schema, modules);

		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('contacts', {
				email: 'live@example.com',
				source: 'api',
				doiStatus: 'pending',
				doiConfirmationToken: 'secret-doi-token',
				doiTokenExpiresAt: now + 100000,
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.run((ctx) =>
			ctx.db.insert('contacts', {
				email: 'erased@example.com',
				source: 'api',
				doiStatus: 'pending',
				doiConfirmationToken: 'erased-token',
				deletedAt: now,
				createdAt: now,
				updatedAt: now,
			})
		);

		const recent = await t.query(api.contacts.analytics.getRecent, { limit: 50 });

		// Soft-deleted contact excluded.
		expect(recent).toHaveLength(1);
		expect(recent[0]!.email).toBe('live@example.com');
		// Bearer capability for /confirm/doi never leaves the backend.
		for (const row of recent) {
			expect(row).not.toHaveProperty('doiConfirmationToken');
			expect(row).not.toHaveProperty('doiTokenExpiresAt');
		}
	});

	it('clamps an oversized limit to the 500 cap', async () => {
		const t = convexTest(schema, modules);

		const now = Date.now();
		for (let i = 0; i < 3; i++) {
			await insertContact(t, now - i);
		}

		// A hostile/buggy caller asking for a huge page is clamped; it still
		// returns at most the available live rows and never throws.
		const recent = await t.query(api.contacts.analytics.getRecent, { limit: 1_000_000 });
		expect(recent.length).toBe(3);
	});
});
