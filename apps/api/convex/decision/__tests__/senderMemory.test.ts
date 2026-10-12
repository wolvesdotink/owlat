/**
 * D12 sender memory (ADR-0073): exact matches only, scoped by mailbox or Team
 * Inbox, authenticated sender, task, thread state, policy and model; expiring;
 * invalidated by an owner correction or by mail that fails DMARC. Advisory: it
 * records whether it would have settled a message and what it would have said.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact, createTestInboundMessage } from '../../__tests__/factories';
import { modules } from '../../mail/__tests__/helpers.testlib';
import { recordOwnerCorrection } from '../artifacts';
import { invalidateSenderMemoryOnAuthFailure, senderDigest } from '../senderMemory';
import { SENDER_MEMORY_TTL_MS } from '../../lib/decision/routing';

type T = TestConvex<typeof schema>;

const PROVENANCE = {
	provider: 'typesafe' as const,
	modelUsed: 'jev-1.13.0',
	endpoint: 'typesafe-native' as const,
	questionSetId: 'mail.message.team',
	questionSetVersion: 1,
};

async function teamMessage(
	t: T,
	over: Record<string, unknown> = {}
): Promise<Id<'inboundMessages'>> {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'ada@example.com' })
		);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Shipped',
			normalizedSubject: 'shipped',
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
				from: 'Ada <ADA@example.com>',
				dmarcResult: 'pass',
				contactId,
				threadId,
				...over,
			})
		);
	});
}

/** Claim and complete one artifact about `inboundMessageId`, the way a bundle run does. */
async function answer(
	t: T,
	inboundMessageId: Id<'inboundMessages'>,
	opts: { contentHash?: string; labels?: Record<string, string>; policyVersion?: number } = {}
) {
	const policyVersion = opts.policyVersion ?? 1;
	const artifactKey = `mail.category|${inboundMessageId}|${opts.contentHash ?? 'same'}|p${policyVersion}`;
	const claim = await t.mutation(internal.decision.artifacts.claim, {
		artifactKey,
		task: 'mail.category',
		kind: 'shadow',
		subjectKind: 'inbound_message',
		inboundMessageId,
		contentHash: opts.contentHash ?? 'same',
		policyVersion,
		isLocalEndpoint: false,
	});
	if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
	await t.mutation(internal.decision.artifacts.complete, {
		artifactKey,
		leaseExpiresAt: claim.leaseExpiresAt,
		status: 'complete',
		labels: opts.labels ?? { category: 'support', disposition: 'reply' },
		answers: '{}',
		provenance: PROVENANCE,
		calibration: { isAdapterCalibrated: true },
		contextVersion: 'typesafe|jev-1.13.0|',
		memoryKey: opts.contentHash ?? 'same',
	});
	const row = await t.run((ctx) =>
		ctx.db
			.query('decisionArtifacts')
			.withIndex('by_artifact_key', (q) => q.eq('artifactKey', artifactKey))
			.first()
	);
	return JSON.parse(row!.answers!).senderMemory as { kind: string; remembered?: string };
}

const memory = (t: T) => t.run((ctx) => ctx.db.query('senderMemory').collect());

describe('sender memory', () => {
	it('keys a digest of the bare lowercased address, never the address', async () => {
		const t = convexTest(schema, modules);
		await answer(t, await teamMessage(t));
		const [row] = await memory(t);
		expect(row).toMatchObject({
			scope: 'team_inbox',
			senderDigest: senderDigest('ada@example.com'),
			authBasis: 'dmarc_pass',
			matchKind: 'exact',
			matchKey: 'same',
			threadStateKey: 'new',
			modelIdentity: 'typesafe/jev-1.13.0',
			hitCount: 0,
		});
		expect(JSON.stringify(row)).not.toContain('ada@example.com');
		expect(row!.expiresAt - row!.createdAt).toBe(SENDER_MEMORY_TTL_MS);
	});

	it('records that an identical authenticated message would have been settled the same way', async () => {
		const t = convexTest(schema, modules);
		expect(await answer(t, await teamMessage(t))).toEqual({ kind: 'learned' });
		expect(await answer(t, await teamMessage(t))).toEqual({ kind: 'agreed' });
		const [row] = await memory(t);
		expect(row).toMatchObject({ hitCount: 1, lastHitAt: expect.any(Number) });
	});

	it('records a disagreement and what memory would have said', async () => {
		const t = convexTest(schema, modules);
		await answer(t, await teamMessage(t));
		const observed = await answer(t, await teamMessage(t), {
			labels: { category: 'billing', disposition: 'reply' },
		});
		expect(observed).toEqual({
			kind: 'disagreed',
			remembered: JSON.stringify({ category: 'support', disposition: 'reply' }),
		});
		expect(await memory(t)).toHaveLength(1);
	});

	it.each<[string, Record<string, unknown>, { contentHash?: string; policyVersion?: number }]>([
		['different content', {}, { contentHash: 'other' }],
		['another policy version', {}, { policyVersion: 2 }],
		['another thread state', { inReplyTo: '<earlier@example.com>' }, {}],
		['another sender', { from: 'eve@example.com' }, {}],
	])('does not match %s', async (_name, message, opts) => {
		const t = convexTest(schema, modules);
		await answer(t, await teamMessage(t));
		expect(await answer(t, await teamMessage(t, message), opts)).toEqual({ kind: 'learned' });
	});

	it('does not match once the entry has expired', async () => {
		const t = convexTest(schema, modules);
		await answer(t, await teamMessage(t));
		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('senderMemory').collect();
			await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
		});
		expect(await answer(t, await teamMessage(t))).toEqual({ kind: 'learned' });
	});

	it('keeps the Team Inbox and a mailbox apart', async () => {
		const t = convexTest(schema, modules);
		await answer(t, await teamMessage(t));
		const mailboxId = await t.run((ctx) =>
			ctx.db.insert('mailboxes', {
				userId: 'u',
				organizationId: 'o',
				address: 'me@owlat.test',
				domain: 'owlat.test',
				status: 'active',
				usedBytes: 0,
				uidValidity: 1,
				createdAt: 1,
				updatedAt: 1,
			})
		);
		const hits = await t.run((ctx) =>
			ctx.db
				.query('senderMemory')
				.withIndex('by_lookup', (q) =>
					q
						.eq('scope', 'mailbox')
						.eq('mailboxId', mailboxId)
						.eq('senderDigest', senderDigest('ada@example.com'))
				)
				.collect()
		);
		expect(hits).toEqual([]);
	});

	it('learns nothing from an unauthenticated sender or a Team sender without a contact', async () => {
		const t = convexTest(schema, modules);
		expect(await answer(t, await teamMessage(t, { dmarcResult: 'fail' }))).toEqual({
			kind: 'not_applicable',
		});
		expect(await answer(t, await teamMessage(t, { dmarcResult: undefined }))).toEqual({
			kind: 'not_applicable',
		});
		expect(await answer(t, await teamMessage(t, { contactId: undefined }))).toEqual({
			kind: 'not_applicable',
		});
		expect(await memory(t)).toEqual([]);
	});

	it('is invalidated by mail from the sender that fails DMARC', async () => {
		const t = convexTest(schema, modules);
		await answer(t, await teamMessage(t));
		await t.run((ctx) =>
			invalidateSenderMemoryOnAuthFailure(
				ctx,
				{ scope: 'team_inbox' },
				'Ada <ada@example.com>',
				'fail'
			)
		);
		const [row] = await memory(t);
		expect(row).toMatchObject({
			invalidationReason: 'auth_failure',
			invalidatedAt: expect.any(Number),
		});
		// A later authentic answer does not revive it before it expires.
		expect(await answer(t, await teamMessage(t))).toEqual({ kind: 'not_applicable' });
		expect(await memory(t)).toEqual([row]);
	});

	it('invalidates every page of a sender’s entries', async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules);
			const digest = senderDigest('ada@example.com');
			await t.run(async (ctx) => {
				for (let i = 0; i < 230; i++) {
					await ctx.db.insert('senderMemory', {
						scope: 'team_inbox',
						senderDigest: digest,
						authBasis: 'dmarc_pass',
						task: 'mail.category',
						matchKind: 'exact',
						matchKey: `hash-${i}`,
						policyVersion: 1,
						modelIdentity: 'typesafe/jev-1.13.0',
						outcome: '{}',
						outcomeVersion: 1,
						hitCount: 0,
						expiresAt: Date.now() + 1000,
						createdAt: 1,
						updatedAt: 1,
					});
				}
			});
			await t.run((ctx) =>
				invalidateSenderMemoryOnAuthFailure(ctx, { scope: 'team_inbox' }, 'ada@example.com', 'fail')
			);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			const rows = await memory(t);
			expect(rows.filter((row) => row.invalidatedAt === undefined)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('changes no routing: the message is untouched by learning and matching', async () => {
		const t = convexTest(schema, modules);
		const first = await teamMessage(t, { processingStatus: 'drafting' });
		const before = await t.run((ctx) => ctx.db.get(first));
		await answer(t, first);
		await answer(t, await teamMessage(t));
		expect(await t.run((ctx) => ctx.db.get(first))).toEqual(before);
	});

	it('learns nothing from an answer the owner corrected while it was in flight', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await teamMessage(t);
		const artifactKey = 'in-flight';
		const claim = await t.mutation(internal.decision.artifacts.claim, {
			artifactKey,
			task: 'mail.category',
			kind: 'shadow',
			subjectKind: 'inbound_message',
			inboundMessageId,
			contentHash: 'same',
			policyVersion: 1,
			isLocalEndpoint: false,
		});
		if (claim.outcome !== 'claimed') throw new Error(claim.outcome);
		await t.run((ctx) => recordOwnerCorrection(ctx, { inboundMessageId }));
		await t.mutation(internal.decision.artifacts.complete, {
			artifactKey,
			leaseExpiresAt: claim.leaseExpiresAt,
			status: 'complete',
			labels: { category: 'support' },
			answers: '{}',
			provenance: PROVENANCE,
			calibration: { isAdapterCalibrated: true },
			contextVersion: 'typesafe|jev-1.13.0|',
		});
		expect(await memory(t)).toEqual([]);
		const [row] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(row).toMatchObject({ status: 'complete', invalidationReason: 'owner_correction' });

		// The key stays settled: a later run neither re-asks nor wipes the correction.
		await t.run(async (ctx) => {
			await ctx.db.patch(row!._id, { status: 'leased', leaseExpiresAt: Date.now() - 1 });
		});
		const again = await t.mutation(internal.decision.artifacts.claim, {
			artifactKey,
			task: 'mail.category',
			kind: 'shadow',
			subjectKind: 'inbound_message',
			inboundMessageId,
			contentHash: 'same',
			policyVersion: 1,
			isLocalEndpoint: false,
		});
		expect(again).toEqual({ outcome: 'settled' });
	});

	it('drops a completion from a lease that lapsed and was taken over', async () => {
		const t = convexTest(schema, modules);
		const inboundMessageId = await teamMessage(t);
		const args = {
			artifactKey: 'taken-over',
			task: 'mail.category' as const,
			kind: 'shadow' as const,
			subjectKind: 'inbound_message' as const,
			inboundMessageId,
			contentHash: 'same',
			policyVersion: 1,
			isLocalEndpoint: false,
		};
		const first = await t.mutation(internal.decision.artifacts.claim, args);
		if (first.outcome !== 'claimed') throw new Error(first.outcome);
		expect(await t.mutation(internal.decision.artifacts.claim, args)).toEqual({ outcome: 'busy' });
		await t.run(async (ctx) => {
			const [row] = await ctx.db.query('decisionArtifacts').collect();
			await ctx.db.patch(row!._id, { leaseExpiresAt: Date.now() - 1 });
		});
		const second = await t.mutation(internal.decision.artifacts.claim, args);
		if (second.outcome !== 'claimed') throw new Error(second.outcome);
		const late = await t.mutation(internal.decision.artifacts.complete, {
			artifactKey: 'taken-over',
			leaseExpiresAt: first.leaseExpiresAt,
			status: 'complete',
			labels: { category: 'spam' },
			answers: '{}',
			provenance: PROVENANCE,
			calibration: { isAdapterCalibrated: true },
			contextVersion: 'typesafe|jev-1.13.0|',
		});
		expect(late).toEqual({ isApplied: false });
		const [row] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(row).toMatchObject({ status: 'leased', leaseExpiresAt: second.leaseExpiresAt });
	});
});
