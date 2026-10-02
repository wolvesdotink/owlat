/**
 * Send-time optimization — the PURE planner (ADR-0068).
 *
 * The sender picks a start and a window; this module proposes, per contact,
 * the instant inside that window at which to hand the email to the send
 * pipeline. It proposes and nothing more: the enqueue at that instant still
 * goes through the governed send path, so the MTA's pacing, the ramp ceilings
 * and the deliverability gates own throughput exactly as they do for any other
 * send, and the multi-day plan's day budget clamps the window (see
 * `resolveSendTimeWindow`).
 *
 * The choice, in order:
 *
 * 1. HOLDOUT. A deterministic `holdoutPercent` share of the audience is sent at
 *    the start, so the report can compare the two groups honestly.
 * 2. CONTACT. A contact whose own profile carries enough evidence gets the
 *    candidate slot its profile scores highest, read in the profile's zone.
 * 3. ORGANIZATION. Otherwise the organization's histogram, read in the
 *    contact's zone (the zone it would be bucketed in).
 * 4. START. Otherwise the start's wall-clock time in the contact's zone, the
 *    same rule as "send at recipient's local time", when that falls inside the
 *    window; failing that, the start itself.
 *
 * Candidate slots are the start and every local top of the hour after it up to
 * the end of the window, so a contact who reads at 9 gets the email at 9:00.
 */

import type { Doc } from '../_generated/dataModel';
import { isValidTimeZone, localTimeParts, resolveNextSendTime } from '../lib/emailHelpers';
import {
	CONTACT_MIN_EVIDENCE,
	effectiveTimeZone,
	evidenceAt,
	isWellFormedHistogram,
	ORGANIZATION_MIN_EVIDENCE,
	slotScorer,
	type SendTimeHistogram,
	type SendTimeProfile,
} from '../analytics/sendTimeProfile';
import { hashFraction } from './sendVariantSplit';
import type { SendTimeGroup, SendTimeOptimizationSettings } from '../lib/validators/sendTime';
import type { SendVariantMode } from './sendPlanning';

const HOUR_MS = 3_600_000;

/** The window options the schedule panel offers, and the bounds the mutation enforces. */
export const SEND_TIME_WINDOW_HOURS = [6, 12, 24, 48, 72] as const;
export const DEFAULT_SEND_TIME_WINDOW_HOURS = 24;
export const MAX_SEND_TIME_WINDOW_HOURS = 72;
/** Holdout shares the schedule panel offers; any integer 0-50 is accepted. */
export const SEND_TIME_HOLDOUT_PERCENTS = [0, 5, 10, 20] as const;
export const DEFAULT_SEND_TIME_HOLDOUT_PERCENT = 10;
export const MAX_SEND_TIME_HOLDOUT_PERCENT = 50;

/** Why a contact got its slot. */
export type SendTimeSource = 'contact' | 'organization' | 'start' | 'holdout';

export interface PlannedSendTime {
	at: number;
	source: SendTimeSource;
	group: SendTimeGroup;
}

export interface SendTimeWindow {
	startAt: number;
	/** Exclusive. */
	endAt: number;
}

/**
 * Settings validation shared by `schedule` and `reschedule`. Returns an error
 * message, or null when the settings are usable.
 */
export function sendTimeSettingsError(settings: SendTimeOptimizationSettings): string | null {
	const { windowHours, holdoutPercent } = settings;
	if (
		!Number.isInteger(windowHours) ||
		windowHours < 1 ||
		windowHours > MAX_SEND_TIME_WINDOW_HOURS
	) {
		return `The send window must be a whole number of hours between 1 and ${MAX_SEND_TIME_WINDOW_HOURS}`;
	}
	if (
		!Number.isInteger(holdoutPercent) ||
		holdoutPercent < 0 ||
		holdoutPercent > MAX_SEND_TIME_HOLDOUT_PERCENT
	) {
		return `The comparison group must be between 0 and ${MAX_SEND_TIME_HOLDOUT_PERCENT} percent`;
	}
	return null;
}

/**
 * The settings the walker plans with, or undefined. Only a plain send is
 * optimized: an A/B test's verdict would be skewed by spreading its cohort
 * over a day, and the scheduling mutations refuse the combination anyway.
 */
export function sendTimeOptimizationFor(
	campaign: Pick<Doc<'campaigns'>, 'sendTimeOptimization' | 'isABTest'>,
	variantMode: SendVariantMode
): SendTimeOptimizationSettings | undefined {
	if (variantMode !== 'plain' || campaign.isABTest === true) return undefined;
	const settings = campaign.sendTimeOptimization;
	if (!settings || sendTimeSettingsError(settings) !== null) return undefined;
	return settings;
}

/**
 * The window a page plans into. It opens when the campaign started sending.
 * A walk that is still going after its window closed (a multi-day plan resumed
 * on a later day) gets a fresh window from now. When a day budget applies, the
 * window ends with the day the budget belongs to, so a slice never lands in
 * the next day's cap window.
 */
export function resolveSendTimeWindow(args: {
	sentAt: number | undefined;
	windowHours: number;
	now: number;
	dayBudgetEndsAt?: number | undefined;
}): SendTimeWindow {
	const length = args.windowHours * HOUR_MS;
	let startAt = args.sentAt ?? args.now;
	if (args.now >= startAt + length) startAt = args.now;
	let endAt = startAt + length;
	if (args.dayBudgetEndsAt !== undefined) endAt = Math.min(endAt, args.dayBudgetEndsAt);
	return { startAt, endAt: Math.max(endAt, startAt + 1) };
}

interface CandidateSlot {
	at: number;
	hour: number;
	weekday: number;
}

/** The start plus every local top of the hour inside the window, in `timeZone`. */
export function candidateSlots(window: SendTimeWindow, timeZone: string): CandidateSlot[] {
	const first = localTimeParts(window.startAt, timeZone);
	const slots: CandidateSlot[] = [{ at: window.startAt, hour: first.hour, weekday: first.weekday }];
	const topOfHour = window.startAt - (first.minute * 60 + first.second) * 1000;
	for (let at = topOfHour + HOUR_MS; at < window.endAt; at += HOUR_MS) {
		const parts = localTimeParts(at, timeZone);
		slots.push({ at, hour: parts.hour, weekday: parts.weekday });
	}
	return slots;
}

function bestSlot(slots: readonly CandidateSlot[], h: SendTimeHistogram): CandidateSlot | null {
	const score = slotScorer(h);
	let best: CandidateSlot | null = null;
	let bestScore = 0;
	for (const slot of slots) {
		const s = score(slot.hour, slot.weekday);
		// Strictly greater: ties keep the earliest slot.
		if (s > bestScore) {
			best = slot;
			bestScore = s;
		}
	}
	return best;
}

export interface SendTimePlanInput {
	campaignId: string;
	settings: SendTimeOptimizationSettings;
	window: SendTimeWindow;
	/** The organization histogram, summed over its shards; null when there is none. */
	organization: SendTimeHistogram | null;
	/** The organization's zone (General settings), for contacts without one. */
	defaultTimezone: string | undefined;
	/** The start's wall-clock time as the sender picked it, for the last fallback. */
	startWallClock: { hour: number; minute: number } | undefined;
	now: number;
}

export interface SendTimeRecipient {
	_id: string;
	timezone?: string | undefined;
	sendTimeProfile?: SendTimeProfile | undefined;
}

/**
 * A planner for one page (or one preview sample). Candidate slots and the
 * organization's choice are computed once per zone and reused for every
 * contact in it.
 */
export function makeSendTimePlanner(
	input: SendTimePlanInput
): (recipient: SendTimeRecipient) => PlannedSendTime {
	const { window, settings } = input;
	const slotsByZone = new Map<string, CandidateSlot[]>();
	const slotsFor = (zone: string) => {
		let slots = slotsByZone.get(zone);
		if (!slots) {
			slots = candidateSlots(window, zone);
			slotsByZone.set(zone, slots);
		}
		return slots;
	};
	const organization =
		isWellFormedHistogram(input.organization) &&
		evidenceAt(input.organization, input.now) >= ORGANIZATION_MIN_EVIDENCE
			? input.organization
			: null;
	const organizationSlotByZone = new Map<string, CandidateSlot | null>();
	const holdoutFraction = settings.holdoutPercent / 100;

	return (recipient) => {
		if (
			holdoutFraction > 0 &&
			hashFraction(`sto:${input.campaignId}`, recipient._id) < holdoutFraction
		) {
			return { at: window.startAt, source: 'holdout', group: 'holdout' };
		}

		const profile = recipient.sendTimeProfile;
		if (
			isWellFormedHistogram(profile) &&
			isValidTimeZone(profile.timeZone) &&
			evidenceAt(profile, input.now) >= CONTACT_MIN_EVIDENCE
		) {
			const slot = bestSlot(slotsFor(profile.timeZone), profile);
			if (slot) return { at: slot.at, source: 'contact', group: 'optimized' };
		}

		const zone = effectiveTimeZone(recipient.timezone, input.defaultTimezone);
		if (organization) {
			let slot = organizationSlotByZone.get(zone);
			if (slot === undefined) {
				slot = bestSlot(slotsFor(zone), organization);
				organizationSlotByZone.set(zone, slot);
			}
			if (slot) return { at: slot.at, source: 'organization', group: 'optimized' };
		}

		if (input.startWallClock) {
			const local = resolveNextSendTime(
				zone,
				input.startWallClock.hour,
				input.startWallClock.minute,
				window.startAt - 1
			);
			if (local < window.endAt) return { at: local, source: 'start', group: 'optimized' };
		}
		return { at: window.startAt, source: 'start', group: 'optimized' };
	};
}
