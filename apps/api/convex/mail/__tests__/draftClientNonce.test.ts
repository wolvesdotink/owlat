/**
 * `drafts.create` idempotency via `clientNonce` (adoption-gaps D8/E2).
 *
 * The offline-outbox drain passes the queued item's id as the draft client
 * nonce so a replay after a lost response reuses the draft the first attempt
 * created instead of forking a duplicate (and, downstream, a duplicate send).
 * Covers: same-nonce reuse (`existing: true`), distinct nonces stay distinct,
 * the no-nonce path is unchanged, and a nonce hit in ANOTHER mailbox is never
 * reused (no cross-mailbox draft-id leak).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: sessionMock.orgId,
		})),
	};
});

describe('drafts.create clientNonce idempotency', () => {
	it('reuses the draft a previous call created for the same nonce', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		const first = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			clientNonce: 'outbox-item-1',
		});
		expect(first.existing).toBeUndefined();

		const second = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			clientNonce: 'outbox-item-1',
		});
		expect(second.draftId).toBe(first.draftId);
		expect(second.existing).toBe(true);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('mailDrafts').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.clientNonce).toBe('outbox-item-1');
		});
	});

	it('distinct nonces create distinct drafts; no nonce keeps today’s path', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		const a = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			clientNonce: 'outbox-item-A',
		});
		const b = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			clientNonce: 'outbox-item-B',
		});
		const plain = await t.mutation(api.mail.drafts.create, { mailboxId });

		expect(b.draftId).not.toBe(a.draftId);
		expect(plain.draftId).not.toBe(a.draftId);
		expect(plain.draftId).not.toBe(b.draftId);
		expect(plain.existing).toBeUndefined();
	});

	it('never reuses a nonce hit that belongs to a different mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxA = await seedMailbox(t, { address: 'a@hinterland.camp' });
		const mailboxB = await seedMailbox(t, { address: 'b@hinterland.camp' });

		const inA = await t.mutation(api.mail.drafts.create, {
			mailboxId: mailboxA,
			clientNonce: 'shared-nonce',
		});
		const inB = await t.mutation(api.mail.drafts.create, {
			mailboxId: mailboxB,
			clientNonce: 'shared-nonce',
		});

		// The nonce matched a draft in mailbox A, but the caller asked for
		// mailbox B — a fresh draft, never A's id.
		expect(inB.draftId).not.toBe(inA.draftId);
		expect(inB.existing).toBeUndefined();
	});
});
