/**
 * Decision artifacts: one stored verdict per
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
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import {
	aiSubjectKindValidator,
	aiTaskNameValidator,
	calibrationStampValidator,
	decisionArtifactKindValidator,
	decisionProvenanceValidator,
} from '../lib/validators/aiRouting';
import {
	CORRECTED_BY_OWNER,
	DECISION_ARTIFACT_TTL_MS,
	DECISION_LEASE_MS,
	planFor,
} from '../lib/decision/routing';
import {
	DECISION_FEATURE,
	type DecisionBundleTask,
	type DecisionLabels,
} from '../lib/decision/bundles';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { observeAndLearn, subjectSender } from './senderMemory';
import { isExcludedFromHostedDecisions, type ExclusionScope } from './exclusion';
import { isFeatureEnabled } from '../lib/featureFlags';
import { loadRoutingPolicy } from '../aiRouting/policy';
import { configVersionOf } from '../lib/decision/configIdentity';

/** Version of the stored `answers` and `baseline` JSON shapes. */
export const DECISION_ANSWERS_VERSION = 1;

/** One bounded read of a subject's artifacts (per task where a task is named). */
const SUBJECT_ARTIFACT_BATCH = 64;

const labelsValidator = v.record(v.string(), v.string());

export type ClaimOutcome =
	| { readonly outcome: 'claimed'; readonly leaseExpiresAt: number }
	| { readonly outcome: 'settled' }
	| { readonly outcome: 'busy' }
	| { readonly outcome: 'gone' }
	| { readonly outcome: 'excluded' }
	| { readonly outcome: 'disabled' }
	| { readonly outcome: 'stale' }
	| { readonly outcome: 'policy_changed' };

/**
 * The endpoint the call will use, as the action decided it ONCE: the rung,
 * whether it runs on the operator's own hardware, and the snapshot the rung
 * was decided on (the `ai.decisionPlane` flag and the
 * `aiProviderConfig` version, `configVersionOf`, the resolution read). The action dispatches to
 * exactly this endpoint; the claim refuses (`stale`) on EITHER rung once the
 * flag or the configuration is no longer the snapshot, since either can change
 * which rung, and which provider, the call should have had (a provider
 * configured without a usable key is terminal, D3).
 */
const endpointValidator = v.object({
	rung: v.union(v.literal('decision'), v.literal('language')),
	isLocal: v.boolean(),
	isDecisionPlaneOn: v.boolean(),
	configVersion: v.optional(v.string()),
});

type SubjectRef = {
	readonly inboundMessageId?: Id<'inboundMessages'>;
	readonly mailMessageId?: Id<'mailMessages'>;
	readonly mailboxId?: Id<'mailboxes'>;
};

/**
 * The subject as it stands now, checked in the calling mutation (F7): the
 * message and, for Postbox, its active mailbox must exist and still belong
 * together. Null when any of it is gone, so a delayed worker can never write
 * an artifact for, or send out, mail that was deleted or erased meanwhile.
 */
async function liveSubject(
	ctx: { db: MutationCtx['db'] },
	subject: SubjectRef
): Promise<{ correctedAt?: number; exclusion: ExclusionScope } | null> {
	if (subject.inboundMessageId) {
		const message = await ctx.db.get(subject.inboundMessageId);
		if (!message) return null;
		return {
			...(message.decisionCorrectedAt === undefined
				? {}
				: { correctedAt: message.decisionCorrectedAt }),
			exclusion: { kind: 'team_inbox' },
		};
	}
	if (!subject.mailMessageId || !subject.mailboxId) return null;
	const message = await ctx.db.get(subject.mailMessageId);
	if (!message || message.mailboxId !== subject.mailboxId) return null;
	const mailbox = await ctx.db.get(subject.mailboxId);
	if (!mailbox || mailbox.status !== 'active') return null;
	return {
		...(message.decisionCorrectedAt === undefined
			? {}
			: { correctedAt: message.decisionCorrectedAt }),
		exclusion: { kind: 'mailbox', mailboxId: subject.mailboxId },
	};
}

/**
 * Take the artifact key, or learn why not, in one transaction with every
 * check that must hold right before the call:
 *
 * - `gone`: the message, or its mailbox, no longer exists (F7);
 * - `settled`: the owner has corrected this message's labels and the task
 *   judges them (it is never judged after a correction), a complete or
 *   abstained answer exists, or the key was invalidated (a re-lease must not
 *   wipe that);
 * - `disabled`: the master gate the caller honours is off (by default the one
 *   today's classifier honours: `ai.agent` for the Team Inbox, `ai` for
 *   Postbox; Answer mode passes `ai`), or the decision plane is off for a
 *   decision-rung call;
 * - `policy_changed`: the routing policy is no longer the one the worker
 *   planned under, or no longer plans this task in this mode (a switch was
 *   turned off or moved);
 * - `stale`: the `ai.decisionPlane` flag or the provider configuration changed
 *   since the action decided its rung and resolved its provider (either rung);
 * - `excluded`: the mailbox is excluded from hosted decisions and the call
 *   is about to use a hosted endpoint;
 * - `busy`: another worker's lease is live.
 *
 * A failed attempt, a lapsed lease and an expired row may be taken.
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
		endpoint: endpointValidator,
		/** The master gate, when it is not the subject's default (Answer mode: `ai`). */
		masterGate: v.optional(v.union(v.literal('ai'), v.literal('ai.agent'))),
		/**
		 * The execution identity the call will be stamped with (the resolved
		 * decision plane, `lib/decision/configIdentity.ts`, or `language`). An
		 * answer stamped with another identity is stale: the key is reclaimed
		 * and asked again (clarify lane, Sol r3 F2).
		 */
		contextVersion: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<ClaimOutcome> => {
		const { endpoint, masterGate, contextVersion, ...fields } = args;
		const subject = await liveSubject(ctx, fields);
		if (!subject) return { outcome: 'gone' };
		if (isCorrectedFor(fields.task, subject.correctedAt)) return { outcome: 'settled' };
		// The routing policy NOW: a worker that planned under an older policy (a
		// switch turned off or moved since) never calls. Any save bumps the version.
		const policy = await loadRoutingPolicy(ctx);
		const plan = isBundleTask(fields.task) ? planFor(fields.task, policy) : null;
		if (
			policy.policyVersion !== fields.policyVersion ||
			plan?.task !== fields.task ||
			plan.mode !== fields.kind
		) {
			return { outcome: 'policy_changed' };
		}
		// The gates today's classifier calls honour, read again right before the
		// call: the Team Inbox's agent (which requires `ai`), Postbox's `ai`.
		const gate = masterGate ?? (subject.exclusion.kind === 'team_inbox' ? 'ai.agent' : 'ai');
		if (!(await isFeatureEnabled(ctx, gate))) return { outcome: 'disabled' };
		const isDecisionPlaneOn = await isFeatureEnabled(ctx, 'ai.decisionPlane');
		const config = await ctx.db.query('aiProviderConfig').first(); // bounded: singleton
		// The snapshot the rung and the provider were decided on must still be
		// the current one, on either rung, or the call is not the one checked.
		if (
			isDecisionPlaneOn !== endpoint.isDecisionPlaneOn ||
			configVersionOf(config) !== endpoint.configVersion
		) {
			return { outcome: 'stale' };
		}
		if (endpoint.rung === 'decision' && !isDecisionPlaneOn) return { outcome: 'disabled' };
		if (!endpoint.isLocal && (await isExcludedFromHostedDecisions(ctx, subject.exclusion))) {
			return { outcome: 'excluded' };
		}
		const now = Date.now();
		const leaseExpiresAt = now + DECISION_LEASE_MS;
		const existing = await ctx.db
			.query('decisionArtifacts')
			.withIndex('by_artifact_key', (q) => q.eq('artifactKey', fields.artifactKey))
			.first();
		if (existing) {
			if (existing.status === 'leased' && (existing.leaseExpiresAt ?? 0) > now) {
				return { outcome: 'busy' };
			}
			const isAnswered = existing.status === 'complete' || existing.status === 'abstained';
			const isCorrected = existing.invalidatedAt !== undefined;
			// An answer from another provider or model than the one resolved now is
			// not reused: the policy (and so the key) can stay while the
			// configuration changes. A correction stays settled whatever answered.
			const isStale =
				!isCorrected && contextVersion !== undefined && existing.contextVersion !== contextVersion;
			if ((isAnswered || isCorrected) && !isStale && existing.expiresAt > now) {
				return { outcome: 'settled' };
			}
			await ctx.db.replace(existing._id, {
				...fields,
				status: 'leased',
				leaseExpiresAt,
				expiresAt: now + DECISION_ARTIFACT_TTL_MS,
				createdAt: existing.createdAt,
				updatedAt: now,
			});
			return { outcome: 'claimed', leaseExpiresAt };
		}
		await ctx.db.insert('decisionArtifacts', {
			...fields,
			status: 'leased',
			leaseExpiresAt,
			expiresAt: now + DECISION_ARTIFACT_TTL_MS,
			createdAt: now,
			updatedAt: now,
		});
		return { outcome: 'claimed', leaseExpiresAt };
	},
});

function isBundleTask(task: AiTaskName): task is DecisionBundleTask {
	return task in DECISION_FEATURE;
}

/** Whether an owner correction (at `correctedAt`) settles `task` for the message. */
function isCorrectedFor(task: AiTaskName, correctedAt: number | undefined): boolean {
	return correctedAt !== undefined && isBundleTask(task) && CORRECTED_BY_OWNER.has(task);
}

/**
 * The labels a settled key holds, for an inline caller that found it
 * `settled` (Phase 3): only a complete or abstained answer, not invalidated
 * and not expired, stamped with the execution identity resolved now. Null
 * otherwise (a correction, an invalidation, an expiry, another provider or
 * model).
 */
export const answeredLabels = internalQuery({
	args: {
		artifactKey: v.string(),
		/** The execution identity resolved now: an answer stamped with another is not reused. */
		contextVersion: v.string(),
	},
	handler: async (ctx, args): Promise<DecisionLabels | null> => {
		const row = await ctx.db
			.query('decisionArtifacts')
			.withIndex('by_artifact_key', (q) => q.eq('artifactKey', args.artifactKey))
			.first();
		if (!row || (row.status !== 'complete' && row.status !== 'abstained')) return null;
		if (row.invalidatedAt !== undefined || row.expiresAt <= Date.now() || !row.answers) {
			return null;
		}
		if (row.contextVersion !== args.contextVersion) return null;
		const stored = JSON.parse(row.answers) as { labels?: DecisionLabels };
		return stored.labels ?? null;
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
		/**
		 * The sender-memory exact-match key: the fingerprint of the complete
		 * scoped message (`lib/decision/evidence.ts`). Absent when the message
		 * was incomplete or cut, and then nothing is remembered.
		 */
		memoryKey: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<{ isApplied: boolean }> => {
		const row = await heldLease(ctx, args.artifactKey, args.leaseExpiresAt);
		if (!row) return { isApplied: false };
		const subject = await liveSubject(ctx, row);
		if (!subject) {
			// Deleted while the call ran: keep nothing about it.
			await ctx.db.delete(row._id);
			return { isApplied: false };
		}
		const now = Date.now();
		// A correction made at any point before now (even before the claim, by a
		// worker that started late) leaves the answer invalid and unlearned.
		const isCorrected =
			isCorrectedFor(row.task, subject.correctedAt) || row.invalidatedAt !== undefined;
		const isLearnable = args.status === 'complete' && !isCorrected && args.memoryKey !== undefined;
		const sender = isLearnable ? await subjectSender(ctx, row) : null;
		const senderMemory =
			sender && args.memoryKey !== undefined
				? await observeAndLearn(
						ctx,
						sender,
						{
							task: row.task,
							matchKey: args.memoryKey,
							policyVersion: row.policyVersion,
							modelIdentity: `${args.provenance.provider}/${args.provenance.modelUsed ?? 'unknown'}`,
							outcome: JSON.stringify(args.labels),
							outcomeVersion: args.provenance.questionSetVersion,
							sourceArtifactKey: row.artifactKey,
							...(row.mailMessageId ? { sourceMailMessageId: row.mailMessageId } : {}),
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
			...(isCorrected && row.invalidatedAt === undefined
				? { invalidatedAt: now, invalidationReason: 'owner_correction' as const }
				: {}),
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

/**
 * The artifacts of the tasks a correction overrides, task by task, so the
 * per-claim Phase 3 artifacts of the same message can never crowd them out
 * of the bounded read.
 */
async function correctableArtifactsOf(
	ctx: { db: MutationCtx['db'] },
	subject: { inboundMessageId: Id<'inboundMessages'> } | { mailMessageId: Id<'mailMessages'> }
): Promise<Doc<'decisionArtifacts'>[]> {
	const rows: Doc<'decisionArtifacts'>[] = [];
	for (const task of CORRECTED_BY_OWNER) {
		rows.push(
			...('inboundMessageId' in subject
				? await ctx.db
						.query('decisionArtifacts')
						.withIndex('by_inbound_message', (q) =>
							q.eq('inboundMessageId', subject.inboundMessageId).eq('task', task)
						)
						.take(SUBJECT_ARTIFACT_BATCH)
				: await ctx.db
						.query('decisionArtifacts')
						.withIndex('by_mail_message', (q) =>
							q.eq('mailMessageId', subject.mailMessageId).eq('task', task)
						)
						.take(SUBJECT_ARTIFACT_BATCH))
		);
	}
	return rows;
}

/**
 * An owner corrected a decision about this message: mark the message (a later
 * or in-flight job never judges it, keeps its answer or learns from it), and
 * invalidate every artifact it already has.
 */
export async function recordOwnerCorrection(
	ctx: MutationCtx,
	subject: { inboundMessageId: Id<'inboundMessages'> } | { mailMessageId: Id<'mailMessages'> }
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(
		'inboundMessageId' in subject ? subject.inboundMessageId : subject.mailMessageId,
		{ decisionCorrectedAt: now }
	);
	for (const row of await correctableArtifactsOf(ctx, subject)) {
		if (row.invalidatedAt !== undefined) continue;
		await ctx.db.patch(row._id, {
			invalidatedAt: now,
			invalidationReason: 'owner_correction',
			updatedAt: now,
		});
	}
}

/**
 * Delete a purged Postbox message's artifacts with it, and the sender memory
 * learned from it (contract §12, D12). Called from `mail/messagePurge.ts`
 * `deleteMessageRowAndBlobs`, the one way a `mailMessages` row is destroyed.
 * Memory is found through its own index on the source message, so an artifact
 * that retention already deleted cannot hide it.
 */
export async function deleteMailMessageArtifacts(
	ctx: MutationCtx,
	mailMessageId: Id<'mailMessages'>
): Promise<void> {
	for (;;) {
		const learned = await ctx.db
			.query('senderMemory')
			.withIndex('by_source_mail_message', (q) => q.eq('sourceMailMessageId', mailMessageId))
			.take(SUBJECT_ARTIFACT_BATCH);
		for (const memory of learned) await ctx.db.delete(memory._id);
		if (learned.length < SUBJECT_ARTIFACT_BATCH) break;
	}
	for (;;) {
		const rows = await artifactsOfSubject(ctx, { mailMessageId });
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length < SUBJECT_ARTIFACT_BATCH) return;
	}
}
