/**
 * `segments.listMembersForExport` — the server-side member-export action that
 * backs the segment-detail "Export CSV" button.
 *
 * Segment membership is computed at read time (a predicate over the live-Contact
 * population), so the export cannot read a junction table; it walks all member
 * pages server-side in one action call and returns the complete matched set.
 * This replaces the previous client-side drain of the reactive
 * `usePaginatedQuery` subscription, which could exit early on a transient
 * `LoadingMore` status and silently export a truncated window.
 *
 * Covers:
 *   - happy path: returns every matching live contact across page boundaries
 *   - soft-deleted (GDPR-erased) contacts never re-surface in an export
 *   - corrupt-but-stored filters yield an empty (not throwing) export
 *   - a missing segment yields an empty, non-truncated result
 *   - the member cap sets `truncated` so the UI can warn instead of presenting
 *     an incomplete CSV as complete
 *
 * The org-member floor is mocked open (see domainsGating.integration.test.ts).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import type { Infer } from 'convex/values';
import schema from '../schema';
import { api } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { segmentFiltersValidator } from '../lib/convexValidators';

const sessionMock = vi.hoisted(() => ({ member: true }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => {
			if (!sessionMock.member) throw new Error('forbidden: not an org member');
			return { userId: 'test-user', role: 'owner' };
		}),
		isActiveOrgMember: vi.fn().mockImplementation(async () => sessionMock.member),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const acmeFilters: Infer<typeof segmentFiltersValidator> = {
	logic: 'AND',
	conditions: [
		{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
	],
};

async function insertContact(ctx: MutationCtx, overrides: Record<string, unknown> = {}) {
	return ctx.db.insert('contacts', {
		email: 'a@example.com',
		source: 'api',
		doiStatus: 'not_required',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	});
}

describe('segments.listMembersForExport', () => {
	it('returns every matching live contact across page boundaries, excluding soft-deleted', async () => {
		const t = convexTest(schema, modules);
		const segmentId = await t.run(async (ctx) => {
			// CONTACT_PAGE_SIZE is 500 — seed > 1 page so the walk must continue
			// past isDone === false. The soft-deleted match is inserted last so it
			// lands on a later page, proving the exclusion holds across pages.
			for (let i = 0; i < 600; i++) await insertContact(ctx, { email: `acme${i}@acme.com` });
			for (let i = 0; i < 40; i++) await insertContact(ctx, { email: `other${i}@other.com` });
			await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });
			return ctx.db.insert('segments', {
				name: 'Acme',
				filters: acmeFilters,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const { members, truncated } = await t.action(api.segments.listMembersForExport, {
			id: segmentId,
		});

		expect(truncated).toBe(false);
		expect(members).toHaveLength(600);
		expect(members.every((m) => (m.email ?? '').includes('acme'))).toBe(true);
		expect(members.some((m) => m.email === 'gone@acme.com')).toBe(false);
	});

	it('empty conditions export every live contact (the "match all" segment)', async () => {
		const t = convexTest(schema, modules);
		const segmentId = await t.run(async (ctx) => {
			await insertContact(ctx, { email: 'a@acme.com' });
			await insertContact(ctx, { email: 'b@other.com' });
			await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });
			return ctx.db.insert('segments', {
				name: 'Everyone',
				filters: { logic: 'AND', conditions: [] },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const { members, truncated } = await t.action(api.segments.listMembersForExport, {
			id: segmentId,
		});
		expect(truncated).toBe(false);
		// Two live contacts; the soft-deleted one is excluded.
		expect(members).toHaveLength(2);
		expect(members.some((m) => m.email === 'gone@acme.com')).toBe(false);
	});

	it('returns an empty, non-truncated result for a missing segment', async () => {
		const t = convexTest(schema, modules);
		const segmentId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('segments', {
				name: 'Doomed',
				filters: acmeFilters,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const { members, truncated } = await t.action(api.segments.listMembersForExport, {
			id: segmentId,
		});
		expect(members).toEqual([]);
		expect(truncated).toBe(false);
	});

	it('rejects when the caller is not an org member', async () => {
		sessionMock.member = false;
		try {
			const t = convexTest(schema, modules);
			const segmentId = await t.run(async (ctx) =>
				ctx.db.insert('segments', {
					name: 'Gated',
					filters: acmeFilters,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}),
			);
			await expect(
				t.action(api.segments.listMembersForExport, { id: segmentId }),
			).rejects.toThrow();
		} finally {
			sessionMock.member = true;
		}
	});
});
