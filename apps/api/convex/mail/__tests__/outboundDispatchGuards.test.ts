/**
 * What `mail/outbound.dispatchDraft` leaves behind when it must not send: a
 * stale hop, a draft that is gone or no longer pending, and a From the
 * sending mailbox may no longer use. Pinned before the dispatch's decisions
 * moved into `mail/outbound/decision.ts`, so the action is held to the same
 * rows, the same revert and the same blob cleanup.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';

type T = ReturnType<typeof convexTest>;

/** Seed a pending plaintext send from alice's mailbox, `from` as its From. */
async function seedDraft(t: T, from = 'alice@a.test', to = 'bob@b.test') {
	return await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('instanceSettings', {
			featureFlags: { postbox: true, senderAuthBadges: true },
			createdAt: now,
		});
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'u1',
			organizationId: 'o1',
			address: 'alice@a.test',
			domain: 'a.test',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'Sent',
			role: 'sent',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		return await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: [to],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: from,
			subject: 'Hello',
			bodyHtml: '<p>Hi Bob</p>',
			attachments: [],
			state: 'pending_send',
			scheduledSendAt: now + 10_000,
			undoToken: 'tok',
			lastEditedAt: now,
			createdAt: now,
		});
	});
}

async function dispatch(t: T, draftId: Id<'mailDrafts'>, undoToken = 'tok') {
	await t.action(internal.mail.outbound.dispatchDraft, { draftId, undoToken });
	return await t.run(async (ctx) => ({
		draft: await ctx.db.get(draftId),
		sent: await ctx.db.query('mailMessages').collect(),
		blobs: (await ctx.db.system.query('_storage').collect()).length,
	}));
}

describe('mail/outbound · dispatch guards', () => {
	beforeEach(() => {
		vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		vi.stubEnv('MTA_API_KEY', '');
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('sends a pending draft: the draft goes, one Sent row and its stored copy stay', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t);
		const { draft, sent, blobs } = await dispatch(t, draftId);
		expect(draft).toBeNull();
		expect(sent).toHaveLength(1);
		expect(blobs).toBe(1);
	});

	it('leaves the draft alone when the hop carries a stale undo token', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t);
		const { draft, sent, blobs } = await dispatch(t, draftId, 'older-token');
		expect(draft?.state).toBe('pending_send');
		expect(draft?.undoToken).toBe('tok');
		expect(sent).toHaveLength(0);
		expect(blobs).toBe(0);
	});

	it('does nothing for a draft that is no longer pending', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t);
		await t.run(async (ctx) => ctx.db.patch(draftId, { state: 'draft' }));
		const { draft, sent, blobs } = await dispatch(t, draftId);
		expect(draft?.state).toBe('draft');
		expect(sent).toHaveLength(0);
		expect(blobs).toBe(0);
	});

	it('does nothing for a draft that is gone', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t);
		await t.run(async (ctx) => ctx.db.delete(draftId));
		const { sent, blobs } = await dispatch(t, draftId);
		expect(sent).toHaveLength(0);
		expect(blobs).toBe(0);
	});

	it('reverts to the composer and drops the stored copy when the From is not allowed', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraft(t, 'mallory@a.test');
		const { draft, sent, blobs } = await dispatch(t, draftId);
		expect(draft?.state).toBe('draft');
		expect(sent).toHaveLength(0);
		expect(blobs).toBe(0);
	});
});
