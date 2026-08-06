/**
 * THE DEGRADATION MATRIX (plan D2, D3, D14) — the substitution table as CONFIG.
 *
 * "Two code paths for every gate means the degraded path rots" is the named risk
 * this module answers. The answer is NOT an if-branch per integration scattered
 * through the controller: it is ONE TABLE with one entry per absent integration,
 * naming which gate substitutes, which constants tighten and which ceiling caps.
 * The controller reads the table; it never asks "is SNDS connected?" itself.
 *
 * THE TABLE IS DATA, NOT DOCUMENTATION. `./degradation.ts` folds it into the
 * numbers the controller and the dashboard consume, and
 * `__tests__/noScatteredConditionals.test.ts` proves that every entry is
 * exercised and that no consumer re-derives a substitution inline.
 *
 * D2 IS THE INVARIANT THIS FILE EXISTS TO ENCODE. An absent integration lowers
 * measurement confidence and slows the ramp. It NEVER blocks a send, never
 * blocks a phase promotion outright, never surfaces an error and never renders a
 * "setup incomplete" nag — which is why every entry carries `isBlocking: false`
 * as a FIELD (so a fixture asserts it) and an `improvement` sentence phrased as
 * an offer rather than a warning.
 *
 * WHAT AN ENTRY MAY CHANGE, and nothing else:
 *   - which SIGNAL SOURCES stand in for the missing one (`substitutes`),
 *   - K_CLEAN (`cleanWindowsRequired`) and the additive step (`stepMultiplier`),
 *   - how long a cell dwells before a phase promotion (`dwellMultiplier`),
 *   - how high the phase ladder may go (`ceilingPhaseDelta`),
 *   - the complaint threshold (`complaintMaxOverride`),
 *   - the pace actuator's hard cap in warming-schedule days (`paceCeilingDay`),
 *   - the cell's measurement confidence and the sentences that explain it.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	percentagePoints,
	rateFraction,
	type PercentagePoints,
	type RateFraction,
} from './gateConfig';
import type { RampGateConfidence } from './gateTypes';

/** The integrations the ramp can measure BETTER with, and works WITHOUT. */
export const RAMP_INTEGRATION_IDS = [
	'reference_transport',
	'google_postmaster',
	'microsoft_snds',
	'complaint_feedback_loop',
	'seed_mailboxes',
	'commercial_placement_api',
] as const;

export type RampIntegrationId = (typeof RAMP_INTEGRATION_IDS)[number];

/**
 * Which integrations this deployment actually has. Every key is REQUIRED — an
 * optional map would let a caller forget a key and silently get the equipped
 * behaviour for an integration nobody connected, which is the one direction the
 * matrix must never fail in.
 */
export type RampIntegrationPresence = Readonly<Record<RampIntegrationId, boolean>>;

/**
 * The signal a substitution runs on. Named rather than described, because the
 * dashboard renders these and the audit row records them: "the microsoft cell is
 * running on its own outcome counters" is a fact the table produced.
 *
 * A SOURCE HAS TO BE SOMETHING EVERY CELL IT IS CLAIMED FOR ACTUALLY RUNS ON.
 * `smtp_classification` was in this list and named by the Microsoft entry below.
 * Its producer now exists — issue #501 wired the MTA's categories into
 * `analytics/smtpResponseCategories.ts` — but the name still does not belong
 * here, and for a second reason the first one hid: the clause that reads those
 * counts (`evaluateSmtpBlockMessages`) is on the STANDALONE evaluator alone,
 * while every entry in this table applies to relay-equipped deployments too. A
 * source this table names is rendered on the cell's confidence note and recorded
 * in every audit row for it, so naming it would tell a relay-equipped operator
 * their Microsoft cell runs on a signal its evaluator never consults. Making
 * the entry conditional on the evaluator is a change to the table's shape, not a
 * line in this list.
 */
export const RAMP_SUBSTITUTE_SOURCES = [
	/** The warming-pace multiplier stands in for the share actuator (D3). */
	'pace_actuator',
	'trailing_baseline_engagement',
	'seed_placement',
	'own_bounce_deferral_complaint',
	'cfbl_address_reports',
	'unsubscribe_rate_proxy',
	'self_hosted_seeds',
] as const;

export type RampSubstituteSource = (typeof RAMP_SUBSTITUTE_SOURCES)[number];

/**
 * Which cells an entry applies to. `'all'` rather than the full provider list so
 * that adding a destination provider does not silently narrow an existing
 * substitution to the providers someone remembered to type out.
 */
export type RampSubstitutionScope = 'all' | readonly DestinationProviderKey[];

export interface RampSubstitutionEntry {
	readonly integration: RampIntegrationId;
	/** Operator-facing name of the thing that is absent. */
	readonly label: string;
	readonly scope: RampSubstitutionScope;
	/**
	 * What runs INSTEAD. EMPTY IS A LEGITIMATE VALUE and means exactly what the
	 * plan says about seed mailboxes: "substitute NOTHING — this is the one true
	 * gap". An empty list is why `paceCeilingDay` exists.
	 */
	readonly substitutes: readonly RampSubstituteSource[];
	/**
	 * ABSOLUTE override of K_CLEAN, not a delta: the plan states "K_CLEAN 3 -> 5",
	 * a number, and two entries that each added one would silently compose into 7.
	 * When several entries carry one, `./degradation.ts` takes the STRICTEST.
	 */
	readonly cleanWindowsRequired?: number;
	/** Multiplier on the additive step. The plan's "step HALVED" is 0.5. */
	readonly stepMultiplier?: number;
	/** Multiplier on the dwell time required before a phase promotion. */
	readonly dwellMultiplier?: number;
	/** Rungs to cap the phase ceiling by. The plan's "one phase lower" is -1. */
	readonly ceilingPhaseDelta?: number;
	/** Absolute complaint-gate ceiling replacing the equipped one when tighter. */
	readonly complaintMaxOverride?: RateFraction;
	/**
	 * The furthest DAY of the published base warming schedule the pace actuator
	 * may reach. The plan's one hard stop on the standalone path: with no seed
	 * mailboxes there is nothing measuring the spam folder at all, so the pace may
	 * not exceed the day-14 cap and the UI says why.
	 */
	readonly paceCeilingDay?: number;
	/** What this cell's measurement is worth while the integration is absent. */
	readonly confidence: RampGateConfidence;
	/** The confidence sentence. One home for the copy (D14). */
	readonly confidenceNote: string;
	/**
	 * The CONCRETE affordance: which integration to connect and what it buys.
	 * An offer, never a warning and never a nag (D2).
	 */
	readonly improvement: string;
	/**
	 * WHETHER THIS DEPLOYMENT CAN ACT ON THE OFFER AT ALL.
	 *
	 * `false` for an integration Owlat does not implement: its absence costs
	 * nothing and there is no button to press, so surfacing its note and its offer
	 * on every cell for ever would be an unactionable permanent nag — precisely
	 * what D2 forbids. The entry still exists (the table is the plan's table, and
	 * the absence has a stated, non-alarming answer); it simply contributes no
	 * copy. Every entry an operator CAN act on carries `true`.
	 */
	readonly offersImprovement: boolean;
	/** Always false, as a FIELD so a fixture asserts D2 rather than assuming it. */
	readonly isBlocking: false;
}

const COMPLAINT_TIGHTENED: RateFraction = rateFraction(0.0005);

/**
 * THE TABLE. One entry per absent integration, verbatim from the plan's
 * "gates, degraded honestly" section.
 *
 * ORDER IS NOT SIGNIFICANT — every fold in `./degradation.ts` is commutative
 * (strictest wins, multipliers multiply, deltas sum) precisely so that a reader
 * never has to hold a precedence rule in their head as well as the table.
 */
export const RAMP_DEGRADATION_MATRIX: readonly RampSubstitutionEntry[] = [
	{
		integration: 'reference_transport',
		label: 'a reference transport (an ESP you already pay for)',
		scope: 'all',
		// The share actuator needs a second arm; without one the SAME controller
		// drives the warming-pace multiplier instead (D3), engagement falls back to
		// the trailing baseline and placement to self-hosted seeds.
		substitutes: ['pace_actuator', 'trailing_baseline_engagement', 'seed_placement'],
		cleanWindowsRequired: 5,
		stepMultiplier: 0.5,
		confidence: 'low',
		confidenceNote:
			'Measurement confidence: low — with no reference transport there is no concurrent arm to compare against, so this cell is measured against its own recent history.',
		improvement:
			'Connect a transport you already pay for to add a side-by-side comparison arm — it raises this cell to high confidence and lets the ramp advance in full steps.',
		offersImprovement: true,
		isBlocking: false,
	},
	{
		integration: 'google_postmaster',
		label: 'Google Postmaster Tools',
		scope: ['gmail'],
		substitutes: ['own_bounce_deferral_complaint', 'seed_placement'],
		dwellMultiplier: 2,
		confidence: 'medium',
		confidenceNote:
			'Measurement confidence: medium — Gmail reputation is inferred from our own bounce, deferral and complaint rates plus seed placement at Gmail.',
		improvement:
			'Connect Google Postmaster Tools to read Gmail’s own reputation and spam-rate reporting for this domain — it halves the dwell time this cell serves before each phase promotion.',
		offersImprovement: true,
		isBlocking: false,
	},
	{
		integration: 'microsoft_snds',
		label: 'Microsoft SNDS',
		scope: ['microsoft'],
		// THE SAME SUBSTITUTION THE GMAIL CELL MAKES, and for the same reason: with
		// no external reputation feed the cell is judged on the outcomes of its own
		// sends.
		//
		// NOT `smtp_classification`, which this entry claimed until issue #501 was
		// read to the end. Microsoft IS unusually explicit in its 5xx text, the MTA
		// does classify it, and since #501 those per-category counts DO reach Convex
		// per (cell, arm). What still disqualifies the name is SCOPE: the clause
		// that consumes them (`evaluateSmtpBlockMessages`) runs on the standalone
		// evaluator only, and this entry covers relay-equipped deployments too,
		// whose gate 2 is the deferral rate alone. Naming it here would put on the
		// cell's confidence note — and in every audit row for that cell — a signal
		// half the deployments it covers never consult. The name comes back when
		// the table can express the condition.
		//
		// `seed_placement` IS CONDITIONAL, exactly as it is on the Gmail entry
		// above, and the table cannot express the condition because the fold unions
		// substitutes rather than retracting them. Two things narrow it: every probe
		// the shadow copy writes is a CAMPAIGN probe (`analytics/
		// seedPlacementSweeps.ts`, issue #500), so the transactional and automation
		// Microsoft cells have no placement evidence and gate 5 holds on them; and a
		// deployment with no seed mailboxes at all has none anywhere. Neither is a
		// signal claimed for a cell that never runs it, because the `seed_mailboxes`
		// entry below is present in exactly those deployments and says so in its own
		// note ("nothing is currently observing where this mail lands") — the
		// operator reads BOTH notes, and the narrower one is the one that answers.
		substitutes: ['own_bounce_deferral_complaint', 'seed_placement'],
		dwellMultiplier: 2,
		ceilingPhaseDelta: -1,
		confidence: 'low',
		confidenceNote:
			'Measurement confidence: low — Microsoft SNDS is not connected, so the Microsoft cell is judged on our own bounce, deferral and complaint rates plus seed placement at Microsoft.',
		improvement:
			'Connect Microsoft SNDS to measure this IP’s complaint band directly — it lifts the Microsoft cell’s phase ceiling by one rung and halves its dwell time.',
		offersImprovement: true,
		isBlocking: false,
	},
	{
		integration: 'complaint_feedback_loop',
		label: 'a complaint feedback loop (FBL)',
		scope: 'all',
		substitutes: ['cfbl_address_reports', 'unsubscribe_rate_proxy'],
		// With no feedback loop the complaint signal is second-hand, so the line it
		// is judged against moves in: 0.1% -> 0.05% equivalent.
		complaintMaxOverride: COMPLAINT_TIGHTENED,
		confidence: 'medium',
		confidenceNote:
			'Measurement confidence: medium — complaints are counted from CFBL-Address reports and the one-click unsubscribe rate rather than from a provider feedback loop.',
		improvement:
			'Enrol in a provider feedback loop to count complaints directly — it restores the standard 0.1% complaint threshold in place of the tightened 0.05% proxy line.',
		offersImprovement: true,
		isBlocking: false,
	},
	{
		integration: 'seed_mailboxes',
		label: 'seed mailboxes',
		scope: 'all',
		// THE ONE TRUE GAP. Nothing else in the system observes the spam folder, so
		// there is nothing to substitute — the ramp pays for it in capacity instead.
		substitutes: [],
		paceCeilingDay: 14,
		confidence: 'low',
		confidenceNote:
			'Measurement confidence: low — nothing is currently observing where this mail lands, so inbox placement is unmeasured.',
		improvement:
			'Add seed mailboxes to watch inbox placement directly — it is what lets daily capacity grow past the day-14 step of the warm-up schedule.',
		offersImprovement: true,
		isBlocking: false,
	},
	{
		integration: 'commercial_placement_api',
		label: 'a commercial placement API',
		scope: 'all',
		// NO CHANGE, deliberately: self-hosted seeds are the EXPECTED configuration
		// here, not a degraded one. The entry exists so the table is complete and so
		// the absence has a stated, non-alarming answer.
		substitutes: ['self_hosted_seeds'],
		confidence: 'high',
		confidenceNote:
			'Measurement confidence: unchanged — inbox placement is measured with your own seed mailboxes, which is the expected configuration.',
		improvement:
			'A commercial placement service can widen the seed panel across more providers; nothing about the ramp depends on one.',
		// NOT AN OFFER THIS DEPLOYMENT CAN TAKE UP. Owlat integrates no commercial
		// placement service, so this entry is absent in EVERY deployment for ever.
		// Rendering its note and its offer on every cell would be a permanent,
		// unactionable nag — the exact thing D2 forbids — so it contributes only its
		// (unchanged) confidence and nothing else.
		offersImprovement: false,
		isBlocking: false,
	},
];

/**
 * The complaint tolerance an absent feedback loop implies, published beside the
 * threshold it belongs to so the two cannot drift apart.
 */
export const COMPLAINT_PROXY_TOLERANCE: PercentagePoints = percentagePoints(0.025);

/** Lookup by id — the table is small, and the map keeps consumers total. */
export const RAMP_DEGRADATION_BY_INTEGRATION: ReadonlyMap<
	RampIntegrationId,
	RampSubstitutionEntry
> = new Map(RAMP_DEGRADATION_MATRIX.map((entry) => [entry.integration, entry]));

/**
 * The same lookup, TOTAL — for callers that need an entry's copy at module load
 * rather than a branch. The map is built from the table over the same closed id
 * union, so a miss is a table that lost a row, not a runtime condition; handing
 * the caller an `undefined` to handle would make it write a fallback sentence,
 * and a fallback sentence for a cell this table already describes is the second
 * copy the whole module exists to prevent.
 */
export function rampSubstitutionEntry(integration: RampIntegrationId): RampSubstitutionEntry {
	const entry = RAMP_DEGRADATION_BY_INTEGRATION.get(integration);
	if (!entry) throw new Error(`No degradation matrix entry for ${integration}`);
	return entry;
}

/** Whether an entry governs a given destination-provider cell. */
export function entryAppliesToProvider(
	entry: RampSubstitutionEntry,
	provider: DestinationProviderKey
): boolean {
	return entry.scope === 'all' || entry.scope.includes(provider);
}

/**
 * The fully-equipped deployment: every integration present. Exported because
 * "equipped" is a configuration the fixtures and the dashboard both need to
 * name, and spelling it out at each site is how two of them come to disagree.
 */
export const RAMP_FULLY_EQUIPPED: RampIntegrationPresence = Object.freeze(
	Object.fromEntries(RAMP_INTEGRATION_IDS.map((id) => [id, true]))
) as RampIntegrationPresence;

/** The zero-third-party deployment — a SUPPORTED configuration (D2), not a gap. */
export const RAMP_FULLY_STANDALONE: RampIntegrationPresence = Object.freeze(
	Object.fromEntries(RAMP_INTEGRATION_IDS.map((id) => [id, false]))
) as RampIntegrationPresence;
