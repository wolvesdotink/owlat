/**
 * Decision artifacts (ADR-0073 §8, contract §9): one stored verdict per
 * bundle, message, content, policy version and question-set version, with
 * the provenance and calibration stamp it was answered under.
 *
 * Coalescing is one atomic lease on the artifact key ({@link claim}): exactly
 * one worker asks the provider for a key, and only that worker's lease may
 * complete it, so a retried step or a duplicate schedule never pays twice and
 * a late answer from a dead lease never overwrites a newer one.
 *
 * Artifacts store labels and probabilities only, never message text. They are
 * advisory or shadow (D9): nothing in routing, archival, Spam movement, the
 * Reply Queue or interpretation eligibility reads them. Only a `complete`
 * artifact with no `invalidatedAt` may be reused, and the block-only auto-send
 * gate refuses any verdict without a valid calibration stamp.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import {
	aiSubjectKindValidator,
	aiTaskNameValidator,
	calibrationStampValidator,
	decisionArtifactKindValidator,
	decisionProvenanceValidator,
} from '../lib/validators/aiRouting';
import { DECISION_ARTIFACT_TTL_MS, DECISION_LEASE_MS } from '../lib/decision/routing';
import { observeAndLearn, subjectSender } from './senderMemory';

/** Version of the stored `answers` and `baseline` JSON shapes. */
export const DECISION_ANSWERS_VERSION = 1;

/** Artifacts one subject can hold: a task per bundle per policy version. Bounded. */
const SUBJECT_ARTIFACT_BATCH = 64;

const labelsValidator = v.record(v.string(), v.string());

export type ClaimOutcome =
	| { readonly outcome: 'claimed'; readonly leaseExpiresAt: number }
	| { readonly outcome: 'settled' }
	| { readonly outcome: 'busy' };

/**
 * Take the artifact key, or learn why not. `settled`: a complete or abstained
 * answer exists, or the key was invalidated (the owner already corrected this
 * message, so asking again buys nothing, and a re-lease must not wipe the
 * correction). `busy`: another worker's lease is live. A failed attempt, a
 * lapsed lease and an expired row may be taken.
 */
export const claim = internalMutation({
	args: {
		artifactKey: v.string(),
		task: aiTaskNameValidator,
		kind: decisionArtifactKindValidator,
		subjectKind: aiSubjectKindValidator,
		inboundMessageId: v.optional(v.id('inboundMessages')),
		mailMessageId: v.optional(v.id('mailMessages')),
		mailboxId: v.optional(v.id('mailboxes')),
		contentHash: v.string(),
		policyVersion: v.number(),
		rootRequestId: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<ClaimOutcome> => {
		const now = Date.now();
		const leaseExpiresAt = now + DECISION_LEASE_MS;
		const existing = await ctx.db
			.query('decisionArtifacts')
			.withIndex('by_artifact_key', (q) => q.eq('artifactKey', args.artifactKey))
			.first();
		if (existing) {
			if (existing.status === 'leased' && (existing.leaseExpiresAt ?? 0) > now) {
				return { outcome: 'busy' };
			}
			const isAnswered = existing.status === 'complete' || existing.status === 'abstained';
			const isCorrected = existing.invalidatedAt !== undefined;
			if ((isAnswered || isCorrected) && existing.expiresAt > now) return { outcome: 'settled' };
			await ctx.db.replace(existing._id, {
				...args,
				status: 'leased',
				leaseExpiresAt,
				expiresAt: now + DECISION_ARTIFACT_TTL_MS,
				createdAt: existing.createdAt,
				updatedAt: now,
			});
			return { outcome: 'claimed', leaseExpiresAt };
		}
		await ctx.db.insert('decisionArtifacts', {
			...args,
			status: 'leased',
			leaseExpiresAt,
			expiresAt: now + DECISION_ARTIFACT_TTL_MS,
			createdAt: now,
			updatedAt: now,
		});
		return { outcome: 'claimed', leaseExpiresAt };
	},
});

/** The live lease row for `artifactKey`, or null when the caller no longer holds it. */
async function heldLease(
	ctx: MutationCtx,
	artifactKey: string,
	leaseExpiresAt: number
): Promise<Doc<'decisionArtifacts'> | null> {
	const row = await ctx.db
		.query('decisionArtifacts')
		.withIndex('by_artifact_key', (q) => q.eq('artifactKey', artifactKey))
		.first();
	return row && row.status === 'leased' && row.leaseExpiresAt === leaseExpiresAt ? row : null;
}

/**
 * Store the answer under the caller's lease, and, in the same transaction,
 * compare it with sender memory and remember it (D12, advisory). A lease that
 * lapsed and was taken over is not ours to complete: the call is dropped.
 */
export const complete = internalMutation({
	args: {
		artifactKey: v.string(),
		leaseExpiresAt: v.number(),
		status: v.union(v.literal('complete'), v.literal('abstained')),
		labels: labelsValidator,
		/** JSON of the typed answers (kinds, values, probabilities); never text. */
		answers: v.string(),
		provenance: decisionProvenanceValidator,
		calibration: calibrationStampValidator,
		/** The decision plane identity the answer came from (`lib/decision/configIdentity.ts`). */
		contextVersion: v.string(),
		baseline: v.optional(labelsValidator),
		isAgreement: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<{ isApplied: boolean }> => {
		const row = await heldLease(ctx, args.artifactKey, args.leaseExpiresAt);
		if (!row) return { isApplied: false };
		const now = Date.now();
		// Memory learns only from a complete answer the owner has not corrected
		// while it was in flight (the correction marks the leased row).
		const isLearnable = args.status === 'complete' && row.invalidatedAt === undefined;
		const sender = isLearnable ? await subjectSender(ctx, row) : null;
		const senderMemory = sender
			? await observeAndLearn(
					ctx,
					sender,
					{
						task: row.task,
						matchKey: row.contentHash,
						policyVersion: row.policyVersion,
						modelIdentity: `${args.provenance.provider}/${args.provenance.modelUsed ?? 'unknown'}`,
						outcome: JSON.stringify(args.labels),
						outcomeVersion: args.provenance.questionSetVersion,
						sourceArtifactKey: row.artifactKey,
					},
					now
				)
			: { kind: 'not_applicable' as const };
		await ctx.db.patch(row._id, {
			status: args.status,
			leaseExpiresAt: undefined,
			answers: JSON.stringify({
				labels: args.labels,
				answers: JSON.parse(args.answers) as unknown,
				senderMemory,
			}),
			answersVersion: DECISION_ANSWERS_VERSION,
			provenance: args.provenance,
			calibration: args.calibration,
			contextVersion: args.contextVersion,
			...(args.baseline
				? { baseline: JSON.stringify(args.baseline), baselineVersion: DECISION_ANSWERS_VERSION }
				: {}),
			...(args.isAgreement === undefined ? {} : { isAgreement: args.isAgreement }),
			updatedAt: now,
		});
		return { isApplied: true };
	},
});

/** No answer under the caller's lease: the key may be taken again by a later run. */
export const fail = internalMutation({
	args: { artifactKey: v.string(), leaseExpiresAt: v.number() },
	handler: async (ctx, args): Promise<null> => {
		const row = await heldLease(ctx, args.artifactKey, args.leaseExpiresAt);
		if (row) {
			await ctx.db.patch(row._id, {
				status: 'failed',
				leaseExpiresAt: undefined,
				updatedAt: Date.now(),
			});
		}
		return null;
	},
});

/** The artifacts about one message, newest policy last. */
async function artifactsOfSubject(
	ctx: { db: MutationCtx['db'] },
	subject: { inboundMessageId: Id<'inboundMessages'> } | { mailMessageId: Id<'mailMessages'> }
): Promise<Doc<'decisionArtifacts'>[]> {
	return 'inboundMessageId' in subject
		? ctx.db
				.query('decisionArtifacts')
				.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', subject.inboundMessageId))
				.take(SUBJECT_ARTIFACT_BATCH)
		: ctx.db
				.query('decisionArtifacts')
				.withIndex('by_mail_message', (q) => q.eq('mailMessageId', subject.mailMessageId))
				.take(SUBJECT_ARTIFACT_BATCH);
}

/** An owner corrected a verdict about this message: none of its artifacts is reusable. */
export async function invalidateArtifactsOf(
	ctx: MutationCtx,
	subject: { inboundMessageId: Id<'inboundMessages'> } | { mailMessageId: Id<'mailMessages'> }
): Promise<void> {
	const now = Date.now();
	for (const row of await artifactsOfSubject(ctx, subject)) {
		if (row.invalidatedAt !== undefined) continue;
		await ctx.db.patch(row._id, {
			invalidatedAt: now,
			invalidationReason: 'owner_correction',
			updatedAt: now,
		});
	}
}

/**
 * Delete a purged Postbox message's artifacts with it (contract §12). Called
 * from `mail/messagePurge.ts` `deleteMessageRowAndBlobs`, the one way a
 * `mailMessages` row is destroyed. A message holds a handful at most.
 */
export async function deleteMailMessageArtifacts(
	ctx: MutationCtx,
	mailMessageId: Id<'mailMessages'>
): Promise<void> {
	for (;;) {
		const rows = await artifactsOfSubject(ctx, { mailMessageId });
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length < SUBJECT_ARTIFACT_BATCH) return;
	}
}
