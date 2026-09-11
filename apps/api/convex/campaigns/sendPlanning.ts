import type { ContentFlag, ContentScanLevel } from '@owlat/email-scanner';
import type { Doc } from '../_generated/dataModel';
import { hashFraction, variantForHash } from './sendVariantSplit';
import { orderByEngagement, planTodaysSlice, type SendPlanState } from './multiDaySendPlan';
import { nextUtcDayStart } from '../lib/utcDay';

/**
 * PURE DECISION LAYER for the campaign send orchestrator.
 *
 * `campaigns/send.ts` owns the I/O — the queries it reads, the mutations it
 * writes, the hops it schedules. Everything it *decides* between those calls
 * lives here: the fire-time guards, the content-scan verdict, the multi-day
 * plan checkpoint, and the per-page variant/language bucketing. Nothing in
 * this module touches `ctx`, the clock or the environment, so every rule is
 * reachable from a unit test with a plain object.
 */

// ─── startCampaignSend: fire-time guards ───────────────────────────────

/** The subset of a campaign row the fire-time guards read. */
export interface StartSendGuardInput {
	readonly status: string;
	readonly scheduledAt?: number;
}

/**
 * Fire-time race guards for a scheduled orchestrator hop, in the order the
 * orchestrator applies them. Returns the skip reason, or `undefined` to
 * proceed.
 *
 * A `sending` campaign is deliberately NOT skipped: race protection against a
 * double orchestrator fire is owned by the campaign lifecycle (`scheduled →
 * sending` is single-write, and a same-state `sending → sending` is recorded
 * but does not refire the effect). The scheduler hop arrives with the status
 * already flipped to `sending`; the cron-tick path arrives with `scheduled`.
 */
export function classifyStartSendSkip(
	campaign: StartSendGuardInput,
	now: number
): string | undefined {
	// The scheduler tick may fire after the campaign was cancelled or
	// unscheduled back to draft.
	if (campaign.status === 'cancelled') return 'Campaign was cancelled';
	if (campaign.status === 'draft') return 'Campaign was unscheduled';
	if (campaign.status === 'sent') return 'Campaign was already sent';
	// `reschedule` patches scheduledAt and schedules a fresh hop but does NOT
	// cancel the original one, so without this an early-firing stale hop would
	// transition the campaign to `sending` and send at the OLD time. The correct
	// hop (or the per-minute cron, which only picks up `scheduledAt <= now`)
	// sends it on time. A hop that arrives as `sending` is unaffected.
	if (
		campaign.status === 'scheduled' &&
		campaign.scheduledAt !== undefined &&
		campaign.scheduledAt > now
	) {
		return 'Not yet due (rescheduled)';
	}
	return undefined;
}

// ─── startCampaignSend: content-scan verdict ───────────────────────────

/** Combined spam-scan + URL-reputation verdict for one campaign's content. */
export interface ContentScanVerdict {
	readonly flags: ContentFlag[];
	readonly score: number;
}

/**
 * Fold the URL-reputation flags into the base content scan. Safe Browsing
 * findings weigh by severity and the total is capped at the scanner's 0-100
 * scale.
 */
export function combineContentScan(
	base: { readonly flags: readonly ContentFlag[]; readonly score: number },
	urlFlags: readonly ContentFlag[]
): ContentScanVerdict {
	let urlReputationScore = 0;
	for (const flag of urlFlags) {
		urlReputationScore += flag.severity === 'high' ? 20 : flag.severity === 'medium' ? 10 : 3;
	}
	return {
		flags: [...base.flags, ...urlFlags],
		score: Math.min(100, base.score + urlReputationScore),
	};
}

/** What the orchestrator does with a non-clean content-scan level. */
export type ContentScanOutcome =
	| { readonly kind: 'proceed' }
	| { readonly kind: 'blocked'; readonly reason: string; readonly contentBlockReason: string }
	| { readonly kind: 'held'; readonly reason: string };

/**
 * Map a scanner level onto the orchestrator's action: `blocked` reverts the
 * campaign to draft with a reason, `suspicious` parks it in `pending_review`
 * for a platform admin, anything else proceeds.
 */
export function classifyContentScan(
	level: ContentScanLevel,
	verdict: ContentScanVerdict
): ContentScanOutcome {
	if (level === 'blocked') {
		return {
			kind: 'blocked',
			reason: `Content blocked by scanner (score: ${verdict.score}/100)`,
			contentBlockReason: `Content blocked: ${verdict.flags.map((f) => f.description).join('; ')}`,
		};
	}
	if (level === 'suspicious') {
		return {
			kind: 'held',
			reason: `Content flagged for review (score: ${verdict.score}/100)`,
		};
	}
	return { kind: 'proceed' };
}

// ─── resolveCampaignPage: the multi-day plan checkpoint ────────────────

type SendPlanSlice = ReturnType<typeof planTodaysSlice>;

/** The plan fields the walker carries on its `campaignSendJobs` row. */
export interface SendPlanJobRow {
	readonly planDayKey?: string;
	readonly enqueuedToday?: number;
	readonly planDayIndex?: number;
	readonly planTotalDays?: number;
	readonly isPlanTruncated?: boolean;
	readonly plannedTotal?: number;
	readonly isPlannedTotalLowerBound?: boolean;
	readonly isPlannedTotalCountAttempted?: boolean;
}

/** What `sendPlanQueries.getSendPlanCapacity` answers with. */
export interface SendPlanCapacity {
	readonly plannedTotal: number | null;
	readonly isPlannedTotalLowerBound?: boolean;
	readonly isPlannedTotalCounted: boolean;
}

/**
 * The plan state this hop reasons with.
 *
 * The denominator is counted ONCE per walk and then carried on the row —
 * together with whether it is the audience size or only a floor under one,
 * because a floor may lengthen the plan and may never shorten it. A hop that
 * did not count keeps the row's denominator; only a hop that counted may
 * replace it, and the flag travels with the number so the two can never
 * describe different counts.
 */
export function buildSendPlanState(job: SendPlanJobRow, capacity: SendPlanCapacity): SendPlanState {
	return {
		planDayKey: job.planDayKey,
		enqueuedToday: job.enqueuedToday,
		planDayIndex: job.planDayIndex,
		planTotalDays: job.planTotalDays,
		isPlanTruncated: job.isPlanTruncated,
		...(capacity.plannedTotal === null
			? {
					plannedTotal: job.plannedTotal,
					isPlannedTotalLowerBound: job.isPlannedTotalLowerBound,
				}
			: {
					plannedTotal: capacity.plannedTotal,
					isPlannedTotalLowerBound: capacity.isPlannedTotalLowerBound,
				}),
	};
}

/** Has this walk now paid for its audience count, whatever it returned? */
export function isPlannedTotalCounted(job: SendPlanJobRow, capacity: SendPlanCapacity): boolean {
	return job.isPlannedTotalCountAttempted === true || capacity.isPlannedTotalCounted;
}

/** The plan state a hop checkpoints, whichever branch it takes. */
export interface SendPlanCheckpoint {
	planDayKey: string;
	planDayIndex: number;
	planTotalDays: number;
	isPlanTruncated: boolean;
	plannedTotal?: number;
	isPlannedTotalLowerBound?: boolean;
	isPlannedTotalCountAttempted?: boolean;
}

export function buildPlanCheckpoint(
	state: SendPlanState,
	slice: SendPlanSlice,
	isCounted: boolean
): SendPlanCheckpoint {
	return {
		planDayKey: slice.dayKey,
		planDayIndex: slice.dayIndex,
		planTotalDays: slice.totalDays,
		isPlanTruncated: slice.isTruncated,
		...(state.plannedTotal === undefined
			? {}
			: {
					plannedTotal: state.plannedTotal,
					isPlannedTotalLowerBound: state.isPlannedTotalLowerBound === true,
				}),
		...(isCounted ? { isPlannedTotalCountAttempted: true } : {}),
	};
}

/**
 * When a spent day must resume, or `undefined` while budget remains.
 *
 * A spent day ALWAYS parks. The planner gives the resume instant with the
 * verdict, and the clock fallback exists only so a spent budget can never fall
 * through into the page read with nothing left to enqueue.
 */
export function resolveParkInstant(slice: SendPlanSlice, now: number): number | undefined {
	if (!slice.isDayExhausted) return undefined;
	return slice.resumeAt ?? nextUtcDayStart(now);
}

/**
 * The page size this hop may read, NARROWED to what is left of today's slice
 * so a page can never overshoot the day's capacity. `undefined` means "no day
 * budget applies" (no projection, or an exact denominator already satisfied)
 * and resolves a full page exactly as the walker did before the plan existed.
 *
 * THE DAY BUDGET HAS TO BOUND THE READ, not just the enqueue, because the
 * cursor is the walk's only record of progress and it advances by exactly what
 * was read — anything read and not enqueued is dropped. Truncating the enqueue
 * while HOLDING the cursor does not fix that: the next day re-reads the
 * identical page and `createBatch`'s idempotency guard turns the whole hop into
 * a no-op, so the walk stops advancing rather than resuming.
 */
export function pageSizeForSlice(slice: SendPlanSlice, fullPageSize: number): number | undefined {
	return slice.remainingToday === undefined
		? undefined
		: Math.min(fullPageSize, slice.remainingToday);
}

// ─── resolveCampaignPage: per-page bucketing ───────────────────────────

export type SendVariantMode = 'plain' | 'ab_test' | 'ab_winner';

/**
 * `undefined` = enqueue untagged, `'A' | 'B'` = enqueue with that variant,
 * `null` = this contact belongs to the OTHER phase and is skipped.
 */
export type VariantBucket = 'A' | 'B' | undefined | null;

/**
 * The deterministic per-contact variant rule. The hash guarantees the test
 * cohort and the held-back remainder partition the audience disjointly, so the
 * winner phase finds the remainder without recording who got the test.
 */
export function makeVariantBucketer(input: {
	readonly variantMode: SendVariantMode;
	readonly campaignId: string;
	readonly testFraction: number;
	readonly winningVariant?: 'A' | 'B';
}): (contactId: string) => VariantBucket {
	const { variantMode, campaignId, testFraction, winningVariant } = input;
	return (contactId) => {
		if (variantMode === 'plain') return undefined; // no tag, always enqueue
		const h = hashFraction(campaignId, contactId);
		// h < testFraction ⇒ test cohort (A/B by sub-bucket); else remainder.
		if (variantMode === 'ab_test') return variantForHash(h, testFraction);
		// ab_winner: h >= testFraction ⇒ remainder gets the winning variant;
		// the test cohort (h < testFraction) is skipped (already sent).
		return h >= testFraction ? (winningVariant ?? 'A') : null;
	};
}

/** One (language, variant) group of a page, ready for a single enqueue. */
export interface RecipientBucket<T> {
	readonly language: string;
	readonly variant: 'A' | 'B' | undefined;
	readonly recipients: T[];
}

/**
 * Split one page into (language, variant) groups, in engagement order.
 *
 * Group only by CONTENT. Destination-provider routing is resolved for each
 * actual recipient at the worker's last pre-attempt boundary, so a
 * custom-domain MX classification cannot misroute a whole bucket.
 *
 * ENGAGEMENT ORDER: each day's slice
 * should be the best remaining audience — engaged recipients open, and openers
 * are what a receiver reads as a positive signal on a warming IP, so the ideal
 * warming behaviour and the ideal recipient experience are the same order.
 * WITHIN THE PAGE, honestly: pages arrive in the audience index's order, so
 * this orders each slice rather than the whole audience.
 */
export function bucketPageRecipients<
	T extends { readonly _id: string; readonly language?: string; readonly engagementScore?: number },
>(
	recipients: readonly T[],
	bucketFor: (contactId: string) => VariantBucket,
	defaultLanguage: string
): RecipientBucket<T>[] {
	const byKey = new Map<string, RecipientBucket<T>>();
	for (const recipient of orderByEngagement(recipients)) {
		const variant = bucketFor(recipient._id);
		if (variant === null) continue; // belongs to the other phase — skip
		const language = recipient.language ?? defaultLanguage;
		const key = `${language}\u0000${variant ?? '-'}`;
		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = { language, variant, recipients: [] };
			byKey.set(key, bucket);
		}
		bucket.recipients.push(recipient);
	}
	return [...byKey.values()];
}

/** The campaign fields the per-hop schedule decision reads. */
export interface PageScheduleInput {
	readonly useRecipientTimezone?: boolean;
	readonly scheduledHour?: number;
	readonly scheduledMinute?: number;
}

/**
 * `ab_winner` deliberately ignores timezone-aware scheduling: by the time the
 * winner is declared, the original scheduled hour/minute is no longer the
 * user's intent (they just want the rest delivered). `plain` and `ab_test`
 * honor it.
 */
export function isTimezoneScheduled(
	campaign: PageScheduleInput,
	variantMode: SendVariantMode
): boolean {
	return (
		variantMode !== 'ab_winner' &&
		campaign.useRecipientTimezone === true &&
		campaign.scheduledHour !== undefined &&
		campaign.scheduledMinute !== undefined
	);
}

/**
 * The variant-B content source: a content test swaps the template, a subject
 * test reuses variant A's html with the alternate subject.
 */
export function resolveVariantBSource(campaign: Pick<Doc<'campaigns'>, 'abTestConfig'>): {
	readonly templateId: string | undefined;
	readonly subject: string | undefined;
} {
	const config = campaign.abTestConfig;
	return {
		templateId:
			config?.testType === 'content' && config.variantBTemplateId
				? config.variantBTemplateId
				: undefined,
		subject: config?.testType === 'subject' ? config.variantBSubject : undefined,
	};
}

/**
 * Can the campaign complete the moment the walk's last page lands?
 *
 *   - plain:     enqueued nobody ⇒ empty audience ⇒ mark sent.
 *   - ab_test:   the audience itself is empty (`totalCandidates === 0`) ⇒ no
 *                test cohort AND no remainder ⇒ mark sent. A non-empty
 *                audience that simply put nobody in the test cohort is NOT
 *                complete — the winner phase still sends the remainder, so the
 *                campaign stays in `sending`/`testing`.
 *   - ab_winner: enqueued nobody ⇒ the remainder was empty ⇒ the whole
 *                campaign (test cohort in phase 1 + empty remainder) is done.
 *
 * In every other case the per-send completion callback / reconcile cron
 * completes it once the last queued send clears.
 */
export function isEmptyAudienceComplete(
	variantMode: SendVariantMode,
	advanced: { readonly totalCandidates: number; readonly enqueuedCount: number } | null | undefined
): boolean {
	if (!advanced) return false;
	return variantMode === 'ab_test' ? advanced.totalCandidates === 0 : advanced.enqueuedCount === 0;
}
