/**
 * Read on arrival (SPEC §2.2, §2.3, §2.6): the run's depth decision for a
 * Postbox arrival read, in one mutation once the run has scoped the message
 * (it brings the security-mail and exact-wording screens of the text).
 *
 *   (b) category wait: a display-only source whose category refinement is
 *       still out (`interpretSources.categoryPendingAt`, stamped at delivery)
 *       waits up to {@link CATEGORY_DEPTH_WAIT_MS}: the lease is given back
 *       and a ceiling scheduled; the category write for this message runs it
 *       sooner (`categoryDefer.ts wakeCategoryDepthWaits`). After the wait the
 *       heuristic category decides, with `arrival.reason.categoryTimeout`.
 *   (d) the inputs: preference, `ai` flag, display-only, sender status,
 *       overrides, a digest rule hint, the category.
 *   (e) `chooseArrivalDepth`. `count` / `none` are settled right here as
 *       terminal skips with no model call (`outstanding.settleArrivalSource`).
 *
 * Admission for every read that will call a model: the owner's
 * `arrivalReadPerOwner` bucket, then (display-only only) the background
 * budget. Over either, display-only mail is settled as an upgradeable
 * `count` in this mutation, never retried and never deferred to the open;
 * eager work over the owner limit waits for the bucket (`wait`), and keeps
 * today's budget behaviour.
 *
 * Only display-only sources are ever read less than in full: anything else
 * keeps today's eager full read untouched (`full`), the `ai` flag included,
 * whose refusal the run's own gate records as today. With the preference off
 * a display-only source was deferred at dispatch (D10); one that reaches a
 * run anyway keeps today's full read.
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { rateLimiter } from '../../lib/rateLimiter';
import { budgetHeadroom } from '../../aiRouting/enforcedBudget';
import type { DegradedBy, Depth, ReasonKey } from '@owlat/shared/arrival';
import {
	ARRIVAL_DEPTH_REASONS,
	chooseArrivalDepth,
	type ArrivalDepthChoice,
} from '@owlat/shared/arrivalDepth';
import { isPersonalMailbox } from '../permissions';
import { senderProfileOf } from '../arrival/projection';
import { loadArrivalRecord, noteArrivalRun } from '../arrival/records';
import { isDisplayOnlyInterpretation } from './defer';
import { leaseLostAt, releaseLeaseIfHeld } from './lease';
import { settleArrivalSource } from './outstanding';
import { isReadOnArrivalOn } from './preferences';
import { loadInterpretSource } from './sources';

/** How long a display-only arrival read waits for this message's category (§2.3.3b). */
export const CATEGORY_DEPTH_WAIT_MS = 2 * 60 * 1000;

/** The reason keys admission and the wait add (`postbox.arrival.reason.*`). */
export const ARRIVAL_ADMISSION_REASONS = {
	budget: ARRIVAL_DEPTH_REASONS.budget,
	ownerLimit: 'arrival.reason.ownerLimit',
	categoryTimeout: 'arrival.reason.categoryTimeout',
	gistUnavailable: 'arrival.reason.gistUnavailable',
	gistFailed: 'arrival.reason.gistFailed',
} as const;

/** What the decision answers the run. */
export type ArrivalVerdict =
	/** Today's interpretation; `isDisplayOnly` makes a later spend refusal a `count`. */
	| { kind: 'full'; isDisplayOnly: boolean }
	| { kind: 'gist' }
	/** Settled without a model call, in the deciding mutation. */
	| { kind: 'settled'; depth: Depth }
	/** Try again at `retryAt` (the category wait, the owner limit for eager work). */
	| { kind: 'wait'; retryAt: number }
	/** Another run holds the source now. */
	| { kind: 'busy'; retryAt: number }
	/** Already terminal, or gone. */
	| { kind: 'done' }
	| { kind: 'gone' };

const mailSourceValidator = v.object({ kind: v.literal('mail'), id: v.id('mailMessages') });

/**
 * Settle a display-only source short of a full read: the terminal skip
 * (count / none) or the upgradeable count admission falls back to, with the
 * record's depth and reasons and the projection, in this mutation.
 */
export async function settleArrivalSkip(
	ctx: MutationCtx,
	row: Doc<'interpretSources'>,
	messageId: Doc<'mailMessages'>['_id'],
	choice: ArrivalDepthChoice & { depth: 'count' | 'none' },
	degradedBy?: DegradedBy
): Promise<void> {
	const [first] = choice.reasonKeys;
	await settleArrivalSource(ctx, row.sourceKey, {
		readOutcome: 'skipped',
		depth: choice.depth,
		isUpgradeable: choice.isUpgradeable,
		...(first ? { skipReason: first } : {}),
	});
	await noteArrivalRun(ctx, messageId, {
		depth: choice.depth,
		reasonKeys: choice.reasonKeys,
		...(degradedBy ? { degradedBy } : {}),
	});
}

/** The upgradeable `count` an admission refusal falls back to (§2.6). Pure. */
export function refusedCount(reason: ReasonKey): ArrivalDepthChoice & { depth: 'count' } {
	return { depth: 'count', reasonKeys: [reason], isUpgradeable: true };
}

export const decideArrivalDepth = internalMutation({
	args: {
		source: mailSourceValidator,
		leaseToken: v.optional(v.string()),
		isSecurityMail: v.boolean(),
		isExactWordingCandidate: v.boolean(),
	},
	handler: async (ctx, args): Promise<ArrivalVerdict> => {
		const row = await loadInterpretSource(ctx, args.source);
		const message = await ctx.db.get(args.source.id);
		if (!message) return { kind: 'gone' };
		// No snapshot: the run records its skip as today.
		if (!row) return { kind: 'full', isDisplayOnly: false };
		const lostAt = await leaseLostAt(ctx, args.source, args.leaseToken);
		if (lostAt !== null) return { kind: 'busy', retryAt: lostAt };
		if (row.readOutcome !== undefined) return { kind: 'done' };
		const mailbox = await ctx.db.get(message.mailboxId);
		const thread = await ctx.db.get(message.threadId);
		if (!mailbox || !thread || !isPersonalMailbox(mailbox) || message.outbound !== undefined) {
			return { kind: 'full', isDisplayOnly: false };
		}
		const isDisplayOnly = await isDisplayOnlyInterpretation(ctx, message);
		if (!isDisplayOnly) return admitEager(ctx, row, message, mailbox.userId);
		// Row 3, the preference off: D10 deferred at dispatch, and a run that
		// reaches this source anyway reads it in full exactly as today.
		const isReadOnArrival = await isReadOnArrivalOn(ctx, mailbox.userId);
		if (!isReadOnArrival) return { kind: 'full', isDisplayOnly: false };

		const now = Date.now();
		const reasons: ReasonKey[] = [];
		if (row.categoryPendingAt !== undefined) {
			const until = row.categoryPendingAt + CATEGORY_DEPTH_WAIT_MS;
			if (now < until) {
				if (args.leaseToken) await releaseLeaseIfHeld(ctx, args.source, args.leaseToken);
				await ctx.scheduler.runAt(until, internal.mail.interpret.arrivalDecide.depthWaitCeiling, {
					source: args.source,
					pendingAt: row.categoryPendingAt,
				});
				return { kind: 'wait', retryAt: until };
			}
			reasons.push({ key: ARRIVAL_ADMISSION_REASONS.categoryTimeout });
		}
		const profile = await senderProfileOf(ctx, mailbox._id, message.fromAddress);
		const record = await loadArrivalRecord(ctx, message._id);
		const placementOverride = thread.placementOverride?.placement ?? profile?.placementOverride;
		const input = {
			isReadOnArrival,
			isAiOn: await isFeatureEnabled(ctx, 'ai'),
			isEligible: true, // the run already recorded an ineligible source's skip
			isDisplayOnly,
			senderStatus: profile?.status,
			...(placementOverride ? { placementOverride } : {}),
			...(record?.rulePlacement === 'digest' ? { ruleDepthHint: 'count' as const } : {}),
			category: thread.category?.label ?? 'other',
			categorySource: thread.category?.source ?? 'heuristic',
			isSecurityMail: args.isSecurityMail,
			isExactWordingCandidate: args.isExactWordingCandidate,
			budget: 'normal' as const,
		};
		const first = chooseArrivalDepth(input);
		if (first.depth === 'deferred') return { kind: 'full', isDisplayOnly: false }; // see above
		let choice: ArrivalDepthChoice & { depth: Depth } = { ...first, depth: first.depth };
		let degradedBy: DegradedBy | undefined;
		if (choice.depth === 'full' || choice.depth === 'gist') {
			const limited = await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: mailbox.userId });
			if (!limited.ok) {
				choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.ownerLimit });
				degradedBy = 'owner_limit';
			} else if (!(await budgetHeadroom(ctx, { priority: 'background' })).isAdmitted) {
				choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.budget });
				degradedBy = 'budget';
			}
		}
		if (!input.isAiOn) degradedBy = 'ai_off';
		const decided = { ...choice, reasonKeys: [...reasons, ...choice.reasonKeys] };
		if (decided.depth === 'count' || decided.depth === 'none') {
			await settleArrivalSkip(
				ctx,
				row,
				message._id,
				{ ...decided, depth: decided.depth },
				degradedBy
			);
			return { kind: 'settled', depth: decided.depth };
		}
		if (row.categoryPendingAt !== undefined) {
			await ctx.db.patch(row._id, { categoryPendingAt: undefined, updatedAt: now });
		}
		await noteArrivalRun(ctx, message._id, {
			depth: decided.depth,
			reasonKeys: decided.reasonKeys,
			modelCalls: 1,
		});
		return decided.depth === 'gist' ? { kind: 'gist' } : { kind: 'full', isDisplayOnly: true };
	},
});

/**
 * Eager work (not display-only): today's full read, paced by the owner's
 * arrival bucket. Over it, the run waits for the bucket (the caller continues
 * at `retryAt`, `needsReplyGates.continuesLater`); it is never deferred to the
 * open and never dropped.
 */
async function admitEager(
	ctx: MutationCtx,
	row: Doc<'interpretSources'>,
	message: Doc<'mailMessages'>,
	ownerUserId: string
): Promise<ArrivalVerdict> {
	const limited = await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: ownerUserId });
	if (!limited.ok) return { kind: 'wait', retryAt: Date.now() + (limited.retryAfter ?? 60_000) };
	if (row.categoryPendingAt !== undefined) {
		await ctx.db.patch(row._id, { categoryPendingAt: undefined, updatedAt: Date.now() });
	}
	await noteArrivalRun(ctx, message._id, {
		depth: 'full',
		reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.openWork }],
		modelCalls: 1,
	});
	return { kind: 'full', isDisplayOnly: false };
}

/**
 * The run's spend was refused after the decision (the gate, the run's hold,
 * a model call): a display-only source is settled as an upgradeable `count`
 * (`arrival.reason.budget`), never retried (§2.6). `gistUnavailable` /
 * `gistFailed`: the gist could not be read or grounded, and counts instead.
 * Checks the lease: a run that lost it writes nothing.
 */
export const settleArrivalCount = internalMutation({
	args: {
		source: mailSourceValidator,
		leaseToken: v.optional(v.string()),
		reason: v.union(v.literal('budget'), v.literal('gistUnavailable'), v.literal('gistFailed')),
	},
	handler: async (ctx, args): Promise<'settled' | 'busy' | 'gone'> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row || !(await ctx.db.get(args.source.id))) return 'gone';
		if ((await leaseLostAt(ctx, args.source, args.leaseToken)) !== null) return 'busy';
		const choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS[args.reason] });
		await settleArrivalSkip(
			ctx,
			row,
			args.source.id,
			choice,
			args.reason === 'budget' ? 'budget' : undefined
		);
		return 'settled';
	},
});

/**
 * The ceiling of a category wait: run the source, unless this message's
 * category write already did (the marker is cleared) or it was settled. The
 * marker stays, so the run reads the wait as timed out. A live lease is
 * waited out first.
 */
export const depthWaitCeiling = internalMutation({
	args: { source: mailSourceValidator, pendingAt: v.number() },
	handler: async (ctx, args): Promise<{ isScheduled: boolean }> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row || row.categoryPendingAt !== args.pendingAt || row.readOutcome !== undefined) {
			return { isScheduled: false };
		}
		if (
			row.leaseToken !== undefined &&
			row.leaseUntil !== undefined &&
			row.leaseUntil > Date.now()
		) {
			await ctx.scheduler.runAt(
				row.leaseUntil,
				internal.mail.interpret.arrivalDecide.depthWaitCeiling,
				args
			);
			return { isScheduled: false };
		}
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: args.source,
		});
		return { isScheduled: true };
	},
});
