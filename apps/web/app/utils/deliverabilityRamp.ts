/**
 * THE RAMP SCREENS' VOCABULARY — presentation only (plan D2, D12, D14, P3-6).
 *
 * DELIVERABILITY FEATURES FAIL WHEN THEY FEEL LIKE MAGIC, so the job of this
 * module is to make a controller decision READ like a decision: what the cell is
 * doing, what is holding it back, and who or what decided that. Every one of
 * those facts is READ, never re-derived — the server recorded the binding
 * constraint and its sentence when the decision was made, and a second
 * implementation here could disagree with the one that actually moved the share.
 *
 * NOTHING THAT IS MERELY UNMEASURED OR UNCONFIGURED IS EVER RENDERED IN A
 * WARNING TONE (plan D2). A cell nobody has sent through, a deployment with no
 * relay, a projection with too little history: each gets a calm sentence and, in
 * every case, a concrete thing the operator could do if they want to — an
 * invitation, never a nag and never a "setup incomplete".
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import {
	INDEPENDENCE_PROJECTION_MIN_DAYS,
	type IndependenceProjection,
	type RampPreset,
} from '@owlat/shared/deliverabilityIndependence';
import { formatNumber, formatPercentage, formatShortDate } from '~/utils/formatters';

export type RampControls = FunctionReturnType<
	typeof api.delivery.rampControlQueries.getRampControls
>;
export type RampCellControl = RampControls['cells'][number];
export type RampCellDecision = NonNullable<RampCellControl['lastDecision']>;
export type IndependenceSummary = FunctionReturnType<
	typeof api.delivery.rampIndependence.getIndependenceSummary
>;
export type RampAdminNotice = FunctionReturnType<
	typeof api.delivery.rampControlQueries.listRampAdminNotices
>[number];

// ============ THE HEADLINE (D14) ============

/**
 * WITH NO RELAY THERE IS NOTHING TO BECOME INDEPENDENT OF, so the screen is not
 * a degraded "Sending independence" — it is a different, honest feature whose
 * headline is today's capacity and what is holding it back (plan D14).
 */
export function independenceHeadline(referenceTransportId: string | null): string {
	return referenceTransportId === null ? 'Warm-up autopilot' : 'Sending independence';
}

export function independenceSubhead(referenceTransportId: string | null): string {
	return referenceTransportId === null
		? 'How much your own server can send today, and what is holding that number back. There is no relay to move away from — this is the whole feature, not a reduced one.'
		: `How much of your mail your own server now carries instead of ${referenceTransportId}.`;
}

/** The month-to-date own-arm volume sentence — always available, always true. */
export function volumeSentence(summary: IndependenceSummary): string {
	return `${formatNumber(summary.monthToDateOwnSends)} messages sent from your own server this month.`;
}

/**
 * THE MONEY, OR AN HONEST ABSENCE. A relay price the product invented would be
 * quoted back at us as fact, so when nobody has recorded one the screen says
 * what it would take to show the figure rather than printing a confident guess.
 */
export function spendAvoidedCopy(summary: IndependenceSummary): string {
	if (summary.spendAvoidedMinorUnits === null || summary.spendAvoidedCurrency === null) {
		return 'Add what your relay charges per thousand messages to see the spend this replaces.';
	}
	const major = summary.spendAvoidedMinorUnits / 100;
	return `${summary.spendAvoidedCurrency} ${major.toFixed(2)} of relay spend avoided this month.`;
}

/**
 * The projected date the relay stops carrying mail — one sentence per arm of the
 * closed union, because the four non-answers mean genuinely different things and
 * a single "unknown" would tell a standalone deployment nothing at all.
 */
export function projectionCopy(projection: IndependenceProjection): string {
	switch (projection.kind) {
		case 'projected':
			return `On the current pace you stop paying a relay around ${formatShortDate(projection.at)} — about ${projection.dailyGainPp.toFixed(2)} points of share gained per day.`;
		case 'already_independent':
			return 'Your own server already carries this traffic. There is no relay bill left to end.';
		case 'not_advancing':
			return 'The share is not climbing at the moment, so there is no honest date to give. It will appear once the ramp starts advancing again.';
		case 'beyond_horizon':
			return 'At the current pace the finish line is more than two years out, which is too far to quote. A faster preset or more volume would bring it closer.';
		case 'insufficient_data':
			return `Not enough history yet — ${formatNumber(projection.usableDays)} of ${formatNumber(INDEPENDENCE_PROJECTION_MIN_DAYS)} days with traffic. Keep sending and the date will appear.`;
	}
}

/** The standalone headline: what the deployment can send today. */
export function capacityCopy(summary: IndependenceSummary): string {
	const remaining = summary.capacity.remainingToday;
	if (remaining === null) {
		return 'No warming ceiling is being reported right now, so there is no daily number to show. Your sending is unaffected.';
	}
	return `${formatNumber(remaining)} more messages can go out from your own server today.`;
}

// ============ CELL STATE ============

export type RampCellTone = 'ok' | 'attention' | 'neutral';

export interface RampCellStatus {
	readonly key: string;
	readonly label: string;
	readonly tone: RampCellTone;
}

/**
 * ONE STATUS PER CELL, decided in ONE table so the word and the colour cannot
 * be chosen in two places and disagree.
 *
 * `unmanaged` and `holding` are NEUTRAL, never warnings: a cell the ramp has not
 * taken over yet and a cell waiting for evidence are both perfectly healthy
 * states of a working deployment (plan D2/D10).
 */
export function rampCellStatus(cell: RampCellControl): RampCellStatus {
	if (!cell.isRampManaged) {
		return { key: 'unmanaged', label: 'Not on the ramp yet', tone: 'neutral' };
	}
	if (cell.graduatedAt !== null) return { key: 'graduated', label: 'Graduated', tone: 'ok' };
	if (cell.isPaused) return { key: 'paused', label: 'Paused by you', tone: 'neutral' };
	if (cell.pinnedShare !== null) {
		return {
			key: 'pinned',
			label: `Pinned at ${formatPercentage(cell.pinnedShare, 0)}`,
			tone: 'neutral',
		};
	}
	if (cell.lastDecision?.direction === 'decrease') {
		return { key: 'retreating', label: 'Pulled back', tone: 'attention' };
	}
	if (cell.lastDecision?.direction === 'increase') {
		return { key: 'advancing', label: 'Advancing', tone: 'ok' };
	}
	return { key: 'holding', label: 'Holding', tone: 'neutral' };
}

/**
 * WHAT IS HOLDING THIS CELL BACK — read off the last decision, never recomputed.
 * A cell with no decisions yet says so plainly instead of inventing a constraint.
 */
export function bindingConstraint(cell: RampCellControl): string {
	if (cell.lastDecision === null) {
		return cell.isRampManaged
			? 'Waiting for the first evaluation.'
			: 'Nothing — this cell is not being ramped yet.';
	}
	return rampReasonLabel(cell.lastDecision.reason);
}

const REASON_LABELS: Record<string, string> = {
	kill_switch: 'The global ramp pause',
	clock_unusable: 'An unusable clock',
	abuse_status: 'The account’s abuse status',
	breaker: 'The MTA circuit breaker',
	dnsbl: 'A critical blocklist listing',
	frozen: 'A cooldown from an earlier retreat',
	freeze_unreadable: 'An unreadable stored cooldown',
	share_unreadable: 'An unreadable stored share',
	holding: 'Not enough fresh evidence',
	evidence_stale: 'Evidence too old to act on',
	awaiting_corroboration: 'A seed tripwire waiting for corroboration',
	capacity_unknown: 'An unusable capacity projection',
	window_open: 'This window has already been counted',
	building_confidence: 'Building a clean streak',
	capacity_ceiling: 'Remaining warming capacity',
	phase_ceiling: 'The phase ceiling',
	healthy: 'Nothing — every gate is green',
	graduated: 'Nothing — the cell is graduated and pinned',
	operator_pause: 'Your pause on this cell',
	operator_pin: 'Your pin on this cell',
	operator_force_advance: 'A manual advance you made',
	operator_phase_reset: 'A manual phase reset you made',
	hard_bounce: 'The hard-bounce gate',
	deferral: 'The deferral gate',
	complaint: 'The complaint gate',
	engagement_ratio: 'The engagement gate',
	seed_placement: 'The seed-placement tripwire',
};

/**
 * BRACKET ACCESS AND AN EXPLICIT FALLBACK, on purpose. The reason union grows
 * with the controller, and a screen that rendered `undefined` for a rung added
 * next month would be worse than one that renders the machine-readable code.
 */
export function rampReasonLabel(reason: string): string {
	return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

export function shareLabel(share: number): string {
	return formatPercentage(share, 0);
}

// ============ PRESETS ============

export interface RampPresetOption {
	readonly value: RampPreset;
	readonly label: string;
	readonly description: string;
}

/**
 * The three presets, described in terms of the TRADE-OFF rather than in praise.
 * None is labelled "recommended": the honest statement is what each costs and
 * buys, and the deployment default is shown separately (plan D14).
 */
export const RAMP_PRESET_OPTIONS: readonly RampPresetOption[] = [
	{
		value: 'conservative',
		label: 'Conservative',
		description:
			'Half-size steps and two extra clean windows before each one. Slowest to finish, least likely to overshoot a provider’s tolerance.',
	},
	{
		value: 'balanced',
		label: 'Balanced',
		description: 'The shipped pace: full-size steps after three consecutive clean windows.',
	},
	{
		value: 'aggressive',
		label: 'Aggressive',
		description:
			'Half again the step size on the same evidence. Reaches full share sooner and retreats from further up when a gate breaks.',
	},
];

export const STREAM_LABELS: Record<string, string> = {
	campaign: 'Campaign',
	automation: 'Automation',
	transactional: 'Transactional',
};

export const PROVIDER_LABELS: Record<string, string> = {
	gmail: 'Gmail',
	microsoft: 'Microsoft',
	yahoo: 'Yahoo',
	apple: 'Apple',
	other: 'Everywhere else',
};

export function rampCellLabel(cell: RampCellControl['cell']): string {
	return `${STREAM_LABELS[cell.stream] ?? cell.stream} → ${PROVIDER_LABELS[cell.destinationProvider] ?? cell.destinationProvider}`;
}
