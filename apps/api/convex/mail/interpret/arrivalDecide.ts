/**
 * Read on arrival (SPEC §2.2, §2.3, §2.6): the run's depth decision for a
 * Postbox arrival read, in one mutation once the run has scoped the message
 * (it brings the security-mail and exact-wording screens of the text).
 * Admission, the owner bucket and the category wait came first, before any
 * predecessor read (`arrivalAdmit.ts`).
 *
 *   (d) the inputs: preference, `ai` flag, display-only, sender status,
 *       overrides, a digest rule hint, the category ({@link arrivalInputs}).
 *   (e) `chooseArrivalDepth`. `count` / `none` are settled right here as
 *       terminal skips with no model call (`outstanding.settleArrivalSource`);
 *       a display-only read the background budget refuses counts too.
 *
 * The exact-wording screen is stored on the arrival record first, whatever
 * the depth (#1384): a candidate never reads as digest or updates. Admission
 * lets a source its text-blind decision counts go on uncharged; when the
 * screen lifts it to a read here, the read takes its owner token here, and
 * over the owner limit it is counted instead (`arrivalAdmit.ts`).
 *
 * Only display-only sources are ever read less than in full: anything else
 * keeps today's eager full read untouched (`full`), the `ai` flag included,
 * whose refusal the run's own gate records as today. A source settled short
 * of a full read is read in full again when eager demand reaches it (Sol r1
 * F2): this same source turning eager, or a full-read prerequisite
 * (`fullRead.ts`). With the preference off a display-only source was
 * deferred at dispatch (D10); one that reaches a run anyway keeps today's
 * full read.
 *
 * Every settlement here and in {@link settleArrivalCount} is bound to the
 * brief's deletion epoch the run loaded at and to the mailbox still being
 * personal: a purge or a team-inbox conversion since then refuses it (Sol r1
 * F5).
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { loadBriefRow } from './briefRow';
import { internalMutation } from '../../lib/writeFence';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { budgetHeadroom } from '../../aiRouting/enforcedBudget';
import type { DegradedBy, Depth, ReasonKey } from '@owlat/shared/arrival';
import {
	ARRIVAL_DEPTH_REASONS,
	chooseArrivalDepth,
	type ArrivalDepthChoice,
} from '@owlat/shared/arrivalDepth';
import { isPersonalMailbox } from '../permissions';
import { senderProfileOf } from '../arrival/projection';
import { loadArrivalRecord, noteArrivalRun, noteExactWordingScreen } from '../arrival/records';
import { rateLimiter } from '../../lib/rateLimiter';
import { isDisplayOnlyInterpretation } from './defer';
import { leaseLostAt } from './lease';
import { settleArrivalSource } from './outstanding';
import { isReadOnArrivalOn } from './preferences';
import { loadInterpretSource } from './sources';

/**
 * How long one owner-token charge covers a source's read job (`arrivalAdmit.ts`):
 * its predecessor loop's continuations, a classifier's continuations, a retry
 * after a lost lease.
 */
export const ARRIVAL_ADMISSION_TTL_MS = 30 * 60 * 1000;

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

/**
 * Whether a settlement for `message` may still be written: the mailbox is
 * personal and no purge or scope conversion bumped the brief's deletion
 * epoch since the run loaded it.
 */
export async function isSettlementCurrent(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	deletionEpoch: number
): Promise<boolean> {
	const mailbox = await ctx.db.get(message.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return false;
	const brief = await loadBriefRow(ctx, { kind: 'mail', id: message.threadId });
	return (brief?.deletionEpoch ?? 0) === deletionEpoch;
}

/**
 * Take the owner's `arrivalReadPerOwner` token for a read job that has no live
 * charge yet, and stamp it (`arrivalAdmit.ts` does the same at admission).
 * False when the owner is over the limit. A source admission already charged
 * rides on its stamp.
 */
export async function chargeOwnerRead(
	ctx: MutationCtx,
	row: Doc<'interpretSources'>,
	userId: string
): Promise<boolean> {
	const now = Date.now();
	if (row.arrivalAdmittedUntil !== undefined && row.arrivalAdmittedUntil > now) return true;
	const limited = await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: userId });
	if (!limited.ok) return false;
	await ctx.db.patch(row._id, { arrivalAdmittedUntil: now + ARRIVAL_ADMISSION_TTL_MS });
	return true;
}

/** The decision table's inputs for a display-only message (§2.2), screens from the caller. */
export async function arrivalInputs(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	screens: { isSecurityMail: boolean; isExactWordingCandidate: boolean }
) {
	const thread = await ctx.db.get(message.threadId);
	const profile = await senderProfileOf(ctx, message.mailboxId, message.fromAddress);
	const record = await loadArrivalRecord(ctx, message._id);
	const placementOverride = thread?.placementOverride?.placement ?? profile?.placementOverride;
	return {
		isReadOnArrival: true,
		isAiOn: await isFeatureEnabled(ctx, 'ai'),
		isEligible: true, // the run already recorded an ineligible source's skip
		isDisplayOnly: true,
		senderStatus: profile?.status,
		...(placementOverride ? { placementOverride } : {}),
		...(record?.rulePlacement === 'digest' ? { ruleDepthHint: 'count' as const } : {}),
		category: thread?.category?.label ?? 'other',
		categorySource: thread?.category?.source ?? 'heuristic',
		...screens,
		budget: 'normal' as const,
	};
}

export const decideArrivalDepth = internalMutation({
	args: {
		source: mailSourceValidator,
		leaseToken: v.optional(v.string()),
		/** The brief's deletion epoch at the run's load. */
		deletionEpoch: v.number(),
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
		const mailbox = await ctx.db.get(message.mailboxId);
		if (!mailbox || !isPersonalMailbox(mailbox) || message.outbound !== undefined) {
			return { kind: 'full', isDisplayOnly: false };
		}
		// The screen lands whatever the depth: open work is placed too (#1384).
		await noteExactWordingScreen(ctx, message._id, args.isExactWordingCandidate);
		// A terminal exclusion stays one, eager demand or not (Sol r2 F3).
		if (row.readOutcome !== undefined && row.isUpgradeable === false) return { kind: 'done' };
		// Eager demand (Sol r1 F2): anything not display-only is read in full,
		// a source settled short of it earlier included (its commit discharges it).
		if (!(await isDisplayOnlyInterpretation(ctx, message))) {
			await noteArrivalRun(ctx, message._id, {
				depth: 'full',
				reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.openWork }],
				modelCalls: 1,
			});
			return { kind: 'full', isDisplayOnly: false };
		}
		if (row.readOutcome !== undefined || row.isDeferred === true) return { kind: 'done' };
		// Row 3, the preference off: a run that reaches this source reads it in full as today.
		if (!(await isReadOnArrivalOn(ctx, mailbox.userId))) {
			return { kind: 'full', isDisplayOnly: false };
		}
		if (!(await isSettlementCurrent(ctx, message, args.deletionEpoch))) return { kind: 'gone' };
		const reasons: ReasonKey[] =
			row.categoryPendingAt !== undefined
				? [{ key: ARRIVAL_ADMISSION_REASONS.categoryTimeout }]
				: [];
		const input = await arrivalInputs(ctx, message, {
			isSecurityMail: args.isSecurityMail,
			isExactWordingCandidate: args.isExactWordingCandidate,
		});
		const first = chooseArrivalDepth(input);
		if (first.depth === 'deferred') return { kind: 'full', isDisplayOnly: false };
		let choice: ArrivalDepthChoice & { depth: Depth } = { ...first, depth: first.depth };
		let degradedBy: DegradedBy | undefined;
		// The owner bucket was taken at admission, unless admission's text-blind
		// decision counted the source (#1384); the budget is display-only's own.
		if (choice.depth === 'full' || choice.depth === 'gist') {
			if (!(await chargeOwnerRead(ctx, row, mailbox.userId))) {
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
			await ctx.db.patch(row._id, { categoryPendingAt: undefined, updatedAt: Date.now() });
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
 * The exact-wording screen of a source admission counted over the owner limit
 * before it was scoped (`arrivalRun.screenCountedArrival`, #1384): stored on
 * its arrival record, so a candidate reads as `today`. The settlement already
 * gave the lease back; the screen is a pure function of the message's own
 * text, so any run writes the same answer. Only a record of a mailbox that is
 * still personal takes it (a purge or a team-inbox conversion removed it).
 */
export const noteCountedArrivalScreen = internalMutation({
	args: { source: mailSourceValidator, isExactWordingCandidate: v.boolean() },
	handler: async (ctx, args): Promise<boolean> => {
		const message = await ctx.db.get(args.source.id);
		if (!message) return false;
		const mailbox = await ctx.db.get(message.mailboxId);
		if (!mailbox || !isPersonalMailbox(mailbox)) return false;
		return noteExactWordingScreen(ctx, message._id, args.isExactWordingCandidate);
	},
});

/**
 * The run's spend was refused after the decision (the gate, the run's hold,
 * a model call): a display-only source is settled as an upgradeable `count`
 * (`arrival.reason.budget`), never retried (§2.6). `gistUnavailable` /
 * `gistFailed`: the gist could not be read or grounded, and counts instead.
 * Checks the lease (a run that lost it writes nothing), the deletion epoch and
 * the scope (a purge or a team-inbox conversion since the load refuses it).
 */
export const settleArrivalCount = internalMutation({
	args: {
		source: mailSourceValidator,
		leaseToken: v.optional(v.string()),
		/** The brief's deletion epoch at the run's load (Sol r1 F5). */
		deletionEpoch: v.number(),
		reason: v.union(v.literal('budget'), v.literal('gistUnavailable'), v.literal('gistFailed')),
	},
	handler: async (ctx, args): Promise<'settled' | 'busy' | 'gone'> => {
		const row = await loadInterpretSource(ctx, args.source);
		const message = await ctx.db.get(args.source.id);
		if (!row || !message) return 'gone';
		// Already counted, by the hold's own refusal (`arrivalHold.ts`): nothing more.
		if (row.readOutcome === 'skipped') return 'settled';
		if ((await leaseLostAt(ctx, args.source, args.leaseToken)) !== null) return 'busy';
		if (!(await isSettlementCurrent(ctx, message, args.deletionEpoch))) return 'gone';
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
