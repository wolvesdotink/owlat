/**
 * Read on arrival (SPEC §2.6, Sol r1 F3/F4): the one admission point of
 * arrival work. Every leased run of a received Postbox message of a personal
 * mailbox whose owner reads on arrival asks it FIRST, before it reads any of
 * the thread's earlier mail (`run.ts runLeased`), so an over-limit run never
 * buys a predecessor read; each predecessor or upgrade read is a run of its
 * own and is admitted the same way.
 *
 *   - Not arrival work (a shared mailbox, a sent message, the preference off,
 *     D10 as today, a source its snapshot makes ineligible, mail that did not
 *     arrive live: no arrival record): `go`, nothing charged.
 *   - A deferred source waits for its open: `done` unless the run reads in full.
 *   - A display-only arrival read: one already settled short of a full read is
 *     `done`; one still waiting for this message's category waits (§2.3.3b,
 *     the lease given back, a ceiling scheduled; this message's category
 *     write runs it sooner, `categoryDefer.wakeCategoryDepthWaits`); one the
 *     text-blind table settles without a model call (a count, a suppressed
 *     sender) goes on uncharged. Its text may still make it a read (an
 *     exact-wording candidate is never counted for a digest choice, #1384):
 *     the run's depth decision then takes the token itself
 *     (`arrivalDecide.chargeOwnerRead`).
 *   - Everything else takes one token of the owner's `arrivalReadPerOwner`
 *     bucket, once per read job (Sol r2 F2): the charge is stamped on the
 *     source for `ARRIVAL_ADMISSION_TTL_MS`, its continuations ride on
 *     the stamp, and its predecessor reads ride on the parent's stamp when the
 *     parent has one (verified, Sol r3 F1). Over it, display-only mail is settled as an upgradeable `count`
 *     in this mutation; eager work and full reads wait for the bucket, and the
 *     wait persists its own continuation at `retryAt` unless the caller
 *     resumes itself (the Reply Queue classifier, a predecessor loop).
 */

import { v } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { rateLimiter } from '../../lib/rateLimiter';
import { chooseArrivalDepth } from '@owlat/shared/arrivalDepth';
import { depthValidator } from '../../lib/validators/arrival';
import { isPersonalMailbox } from '../permissions';
import { loadArrivalRecord } from '../arrival/records';
import {
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { isDisplayOnlyInterpretation } from './defer';
import { isInterpretationEligible } from './eligibility';
import { leaseLostAt, releaseLeaseIfHeld } from './lease';
import { isReadOnArrivalOn } from './preferences';
import { loadInterpretSource } from './sources';
import {
	ARRIVAL_ADMISSION_REASONS,
	ARRIVAL_ADMISSION_TTL_MS,
	CATEGORY_DEPTH_WAIT_MS,
	arrivalInputs,
	refusedCount,
	settleArrivalSkip,
} from './arrivalDecide';

/** How long eager work waits when the limiter names no time. */
const OWNER_LIMIT_FALLBACK_MS = 60_000;

export type ArrivalAdmission =
	| { kind: 'go' }
	/** Settled as an upgradeable count (display-only over the owner limit). */
	| { kind: 'settled' }
	| { kind: 'wait'; retryAt: number }
	| { kind: 'busy'; retryAt: number }
	| { kind: 'done' };

const GO: ArrivalAdmission = { kind: 'go' };

/** A display-only read still inside its category wait: give the lease back and wait. */
async function categoryWait(
	ctx: MutationCtx,
	source: { kind: 'mail'; id: Id<'mailMessages'> },
	pendingAt: number,
	leaseToken: string | undefined
): Promise<ArrivalAdmission | null> {
	const until = pendingAt + CATEGORY_DEPTH_WAIT_MS;
	if (Date.now() >= until) return null;
	if (leaseToken) await releaseLeaseIfHeld(ctx, source, leaseToken);
	await ctx.scheduler.runAt(until, internal.mail.interpret.arrivalDecide.depthWaitCeiling, {
		source,
		pendingAt,
	});
	return { kind: 'wait', retryAt: until };
}

/** Whether `source` carries a live admission stamp from an actual charge. */
async function isStampLive(
	ctx: MutationCtx,
	source: InterpretationSource,
	now: number
): Promise<boolean> {
	const row = await loadInterpretSource(ctx, source);
	return row?.arrivalAdmittedUntil !== undefined && row.arrivalAdmittedUntil > now;
}

export const admitArrivalRun = internalMutation({
	args: {
		source: v.object({ kind: v.literal('mail'), id: v.id('mailMessages') }),
		leaseToken: v.optional(v.string()),
		depth: v.optional(depthValidator),
		isUpgrade: v.optional(v.boolean()),
		/** The caller schedules its own continuation on `wait` (classifier, predecessor loop). */
		isCallerResuming: v.boolean(),
		/**
		 * A predecessor read: the parent run whose loop reads it. Its admission
		 * covers this read only when the parent's source carries a live stamp
		 * from an actual charge (Sol r2 F2, r3 F1); otherwise it is admitted on
		 * its own (an outbound parent, a parent of a shared mailbox, …).
		 */
		parentSource: v.optional(interpretationSourceValidator),
	},
	handler: async (ctx, args): Promise<ArrivalAdmission> => {
		const row = await loadInterpretSource(ctx, args.source);
		const message = await ctx.db.get(args.source.id);
		if (!row || !message) return GO; // the run records what it records today
		const lostAt = await leaseLostAt(ctx, args.source, args.leaseToken);
		if (lostAt !== null) return { kind: 'busy', retryAt: lostAt };
		const mailbox = await ctx.db.get(message.mailboxId);
		if (!mailbox || !isPersonalMailbox(mailbox) || message.outbound !== undefined) return GO;
		if (!(await isReadOnArrivalOn(ctx, mailbox.userId))) return GO;
		// Never read anyway (Spam, a muted thread): the run records the skip.
		if (!isInterpretationEligible(row.eligibility, { direction: 'inbound' }).isEligible) return GO;
		// Arrival work is mail that arrived live (it has an arrival record); the
		// history backfill keeps its own gate and caps.
		if (!(await loadArrivalRecord(ctx, message._id))) return GO;
		const isFull = args.depth === 'full';
		// A terminal exclusion (security mail, a suppressed sender) is never read,
		// whatever asks (Sol r2 F3).
		if (row.readOutcome !== undefined && row.isUpgradeable === false) return { kind: 'done' };
		// D10 leftovers wait for their open, which reads them in full (Sol r1 F1).
		if (!isFull && row.isDeferred === true) return { kind: 'done' };
		const now = Date.now();
		const isDisplayOnly = !isFull && (await isDisplayOnlyInterpretation(ctx, message));
		if (isDisplayOnly) {
			if (row.readOutcome !== undefined) return { kind: 'done' };
			// A gist retry is due only at its time, whoever runs it (Sol r2 F5).
			if (row.arrivalRetryAt !== undefined && row.arrivalRetryAt > now) {
				return { kind: 'wait', retryAt: row.arrivalRetryAt };
			}
			if (row.categoryPendingAt !== undefined) {
				const wait = await categoryWait(ctx, args.source, row.categoryPendingAt, args.leaseToken);
				if (wait) return wait;
			}
			// Counted by the text-blind table: nothing to charge yet. The depth
			// decision charges it if the exact-wording screen makes it a read.
			const pre = chooseArrivalDepth(
				await arrivalInputs(ctx, message, { isSecurityMail: false, isExactWordingCandidate: false })
			);
			if (pre.depth === 'count' || pre.depth === 'none') return GO;
		}
		// Once per read job (Sol r2 F2): the parent's admission covers its
		// predecessor reads, and its continuations ride on its stamp.
		if (args.parentSource && (await isStampLive(ctx, args.parentSource, now))) return GO;
		if (row.arrivalAdmittedUntil !== undefined && row.arrivalAdmittedUntil > now) return GO;
		const limited = await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: mailbox.userId });
		if (!limited.ok) {
			if (isDisplayOnly) {
				const choice = refusedCount({ key: ARRIVAL_ADMISSION_REASONS.ownerLimit });
				await settleArrivalSkip(ctx, row, message._id, choice, 'owner_limit');
				return { kind: 'settled' };
			}
			const retryAt = Date.now() + (limited.retryAfter ?? OWNER_LIMIT_FALLBACK_MS);
			if (!args.isCallerResuming) {
				await ctx.scheduler.runAt(retryAt, internal.mail.interpret.run.interpretMessage, {
					source: args.source,
					...(args.depth ? { depth: args.depth } : {}),
					...(args.isUpgrade ? { isUpgrade: true } : {}),
				});
			}
			return { kind: 'wait', retryAt };
		}
		await ctx.db.patch(row._id, { arrivalAdmittedUntil: now + ARRIVAL_ADMISSION_TTL_MS });
		return GO;
	},
});
