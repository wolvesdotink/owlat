/**
 * What the claim and completion mutations check atomically (ADR-0073, D12,
 * ADR-0060 §9): a deleted message or mailbox is never claimed or completed, a
 * corrected message is never judged or learned from, and an excluded mailbox
 * never reaches a hosted endpoint. Plus the ingestion-time DMARC check that
 * invalidates sender memory whatever the bundles' switches say.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact, createTestInboundMessage } from '../../__tests__/factories';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';
import {
	modules,
	seedFolder,
	seedMailbox,
	seedMessage,
} from '../../mail/__tests__/helpers.testlib';
import { senderDigest } from '../senderMemory';
import { insertDeliveredMessage } from '../../mail/deliveryPipeline/insert';

type T = TestConvex<typeof schema>;

const PROVENANCE = {
	provider: 'typesafe' as const,
	modelUsed: 'jev-1.13.0',
	questionSetId: 'mail.message.team',
	questionSetVersion: 1,
};

async function teamMessage(t: T, over: Record<string, unknown> = {}) {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'ada@example.com' })
		);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Hi',
			normalizedSubject: 'hi',
			contactId,
			contactIdentifier: 'ada@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		return ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				from: 'ada@example.com',
				dmarcResult: 'pass',
				contactId,
				threadId,
				...over,
			})
		);
	});
}

function claimArgs(
	subject:
		| { inboundMessageId: Id<'inboundMessages'> }
		| { mailMessageId: Id<'mailMessages'>; mailboxId: Id<'mailboxes'> },
	isLocalEndpoint = false
) {
	return {
		artifactKey: `k-${JSON.stringify(subject)}`,
		task: 'mail.category' as const,
		kind: 'shadow' as const,
		subjectKind:
			'inboundMessageId' in subject ? ('inbound_message' as const) : ('mail_message' as const),
		...subject,
		contentHash: 'hash',
		policyVersion: 1,
		isLocalEndpoint,
	};
}

function completeArgs(artifactKey: string, leaseExpiresAt: number) {
	return {
		artifactKey,
		leaseExpiresAt,
		status: 'complete' as const,
		labels: { category: 'support' },
		answers: '{}',
		provenance: PROVENANCE,
		calibration: { isAdapterCalibrated: true },
		contextVersion: 'typesafe||',
		memoryKey: 'fingerprint',
	};
}

const rows = (t: T) => t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
const memory = (t: T) => t.run((ctx) => ctx.db.query('senderMemory').collect());

describe('claim and completion guards', () => {
	it('never claims a Team message deleted after its evidence was read (F7)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await teamMessage(t);
		await t.run((ctx) => ctx.db.delete(inboundMessageId));
		const claim = await t.mutation(
			internal.decision.artifacts.claim,
			claimArgs({ inboundMessageId })
		);
		expect(claim).toEqual({ outcome: 'gone' });
		expect(await rows(t)).toEqual([]);
	});

	it('never claims Postbox mail whose message or mailbox is gone (F7)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const mailMessageId = await seedMessage(t, mailboxId);
		await t.run((ctx) => ctx.db.patch(mailboxId, { status: 'deleted' }));
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ mailMessageId, mailboxId }))
		).toEqual({ outcome: 'gone' });
		await t.run(async (ctx) => {
			await ctx.db.patch(mailboxId, { status: 'active' });
			await ctx.db.delete(mailMessageId);
		});
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ mailMessageId, mailboxId }))
		).toEqual({ outcome: 'gone' });
		expect(await rows(t)).toEqual([]);
	});

	it('keeps nothing when the message is deleted while the call runs (F7)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await teamMessage(t);
		const args = claimArgs({ inboundMessageId });
		const claim = await t.mutation(internal.decision.artifacts.claim, args);
		if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
		await t.run((ctx) => ctx.db.delete(inboundMessageId));
		const done = await t.mutation(
			internal.decision.artifacts.complete,
			completeArgs(args.artifactKey, claim.leaseExpiresAt)
		);
		expect(done).toEqual({ isApplied: false });
		expect(await rows(t)).toEqual([]);
		expect(await memory(t)).toEqual([]);
	});

	it('never judges a message the owner corrected before the job claimed it (F4)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await teamMessage(t, { decisionCorrectedAt: Date.now() });
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ inboundMessageId }))
		).toEqual({ outcome: 'settled' });
		expect(await rows(t)).toEqual([]);
	});

	it('neither keeps nor learns an answer the owner corrected while it was in flight (F4)', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await teamMessage(t);
		const args = claimArgs({ inboundMessageId });
		const claim = await t.mutation(internal.decision.artifacts.claim, args);
		if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
		// The correction lands with no artifact to invalidate yet but the lease.
		await t.run((ctx) => ctx.db.patch(inboundMessageId, { decisionCorrectedAt: Date.now() }));
		await t.mutation(
			internal.decision.artifacts.complete,
			completeArgs(args.artifactKey, claim.leaseExpiresAt)
		);
		const [row] = await rows(t);
		expect(row).toMatchObject({ status: 'complete', invalidationReason: 'owner_correction' });
		expect(await memory(t)).toEqual([]);
	});

	it('refuses a hosted endpoint for an excluded mailbox and admits the local engine (F1)', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const mailMessageId = await seedMessage(t, mailboxId);
		await t.run((ctx) => ctx.db.patch(mailboxId, { isExcludedFromHostedDecisions: true }));
		expect(
			await t.mutation(internal.decision.artifacts.claim, claimArgs({ mailMessageId, mailboxId }))
		).toEqual({ outcome: 'excluded' });
		expect(
			await t.mutation(
				internal.decision.artifacts.claim,
				claimArgs({ mailMessageId, mailboxId }, true)
			)
		).toMatchObject({ outcome: 'claimed' });
	});
});

describe('DMARC failures at ingestion (F5)', () => {
	beforeEach(() => expectScheduledFailure('agent/walker:start'));

	function remembered(
		scope: { scope: 'team_inbox' } | { scope: 'mailbox'; mailboxId: Id<'mailboxes'> }
	) {
		return {
			...scope,
			senderDigest: senderDigest('ada@example.com'),
			authBasis: 'dmarc_pass' as const,
			task: 'mail.category' as const,
			matchKind: 'exact' as const,
			matchKey: 'fingerprint',
			policyVersion: 1,
			modelIdentity: 'typesafe/jev-1.13.0',
			outcome: '{}',
			outcomeVersion: 1,
			hitCount: 0,
			expiresAt: Date.now() + 60_000,
			createdAt: 1,
			updatedAt: 1,
		};
	}

	it('a Team message that fails DMARC invalidates the sender’s memory, with every switch off', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await t.run((ctx) => ctx.db.insert('senderMemory', remembered({ scope: 'team_inbox' })));
		const base = {
			from: 'Ada <ada@example.com>',
			to: 'support@org.example',
			subject: 'Hello',
			textBody: 'Body',
			timestamp: Date.now(),
		};
		await t.mutation(internal.inbox.messages.receiveMessage, {
			...base,
			messageId: '<unknown@example.com>',
		});
		expect((await memory(t))[0]?.invalidatedAt).toBeUndefined();
		await t.mutation(internal.inbox.messages.receiveMessage, {
			...base,
			messageId: '<spoof@example.com>',
			dmarcResult: 'fail',
		});
		expect((await memory(t))[0]).toMatchObject({ invalidationReason: 'auth_failure' });
	});

	it('Postbox mail that fails DMARC invalidates the sender’s memory in that mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		const folderId = await seedFolder(t, mailboxId, 'inbox');
		await t.run(async (ctx) => {
			await ctx.db.insert('senderMemory', remembered({ scope: 'mailbox', mailboxId }));
			const mailbox = (await ctx.db.get(mailboxId))!;
			const folder = (await ctx.db.get(folderId))!;
			await insertDeliveredMessage(ctx, {
				mailbox,
				folder,
				rawStorageId: await ctx.storage.store(new Blob(['raw'])),
				rawSize: 3,
				from: 'ada@example.com',
				to: ['me@example.com'],
				cc: [],
				bcc: [],
				subject: 'Invoice',
				textBodyInline: 'Pay now',
				messageId: '<spoof@example.com>',
				receivedAt: Date.now(),
				attachments: [],
				dmarcResult: 'fail',
			});
		});
		expect((await memory(t))[0]).toMatchObject({ invalidationReason: 'auth_failure' });
	});
});
