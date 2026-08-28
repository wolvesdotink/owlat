/**
 * L17 — `blockedEmails.bulkAdd` hardening: the request array is capped, and each
 * added address writes a `blocklist.added` audit entry (the single `add` path
 * already did; a mass block must leave the same attributable trail).
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { MAX_BULK_BLOCK_ADD } from '../blockedEmails';

// Mock the org-permission gate so the mutation reaches its writes with a known
// actor id (same approach as suppressionMirror.integration.test).
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

describe('blockedEmails.bulkAdd — cap + audit', () => {
	it('writes a blocklist.added audit entry per added address', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(api.blockedEmails.bulkAdd, {
			emails: [
				{ email: 'a@example.com', reason: 'manual' as const },
				{ email: 'b@example.com', reason: 'bounced' as const },
			],
		});
		expect(result.added).toBe(2);

		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'blocklist.added'))
				.collect()
		);
		expect(audits).toHaveLength(2);
		for (const entry of audits) {
			expect(entry.userId).toBe('test-user');
			expect((entry.details as { bulk?: boolean }).bulk).toBe(true);
		}
	});

	it('does not double-count / re-audit an already-blocked address', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.blockedEmails.bulkAdd, {
			emails: [{ email: 'dup@example.com', reason: 'manual' as const }],
		});
		const second = await t.mutation(api.blockedEmails.bulkAdd, {
			emails: [{ email: 'dup@example.com', reason: 'manual' as const }],
		});
		expect(second.added).toBe(0);
		expect(second.skipped).toBe(1);
		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'blocklist.added'))
				.collect()
		);
		expect(audits).toHaveLength(1); // only the first insert audited
	});

	it('rejects a request that exceeds the cap before any write', async () => {
		const t = convexTest(schema, modules);
		const emails = Array.from({ length: MAX_BULK_BLOCK_ADD + 1 }, (_, i) => ({
			email: `bulk${i}@example.com`,
			reason: 'manual' as const,
		}));
		await expect(t.mutation(api.blockedEmails.bulkAdd, { emails })).rejects.toThrow(
			/Cannot block more than/
		);
		const rows = await t.run(async (ctx) => ctx.db.query('blockedEmails').collect());
		expect(rows).toHaveLength(0);
	});
});
