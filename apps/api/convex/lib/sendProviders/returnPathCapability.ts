/**
 * Custom return-path capability — the measurement-bias fix (plan G-08).
 *
 * The own-MTA arm stamps a VERP envelope sender and runs its own bounce
 * server, so its feedback is rich. Resend and SES report bounces over their
 * own webhooks. A bring-your-own SMTP relay has NEITHER: its bounces land at
 * the relay and are never seen here. Comparing an arm with full feedback
 * against one with none biases the comparison toward whichever side reports
 * FEWER bounces — exactly backwards. Two answers, both here:
 *
 *  1. Where the relay honours it, stamp OUR VERP envelope sender so relayed
 *     bounces come back to our own bounce server (the wiring lives in the smtp
 *     adapter; the token scheme is the shipped one, `@owlat/shared/verp`).
 *  2. Where it does not, say so: the cell is DEGRADED MEASUREMENT and its
 *     bounce gate runs on a WIDER tolerance instead of pretending the two
 *     arms' numbers are comparable.
 *
 * Plan D2 (additive-only third-party rule) is absolute here: an unsupported,
 * unprobed or never-configured relay lowers confidence and widens a tolerance.
 * It never throws, never blocks a send, never blocks a promotion and never
 * renders an error. Every function in this module is total.
 *
 * "What about a relay that ACCEPTS our MAIL FROM and silently rewrites it?" is
 * why acceptance alone is NOT a verdict. The probe state machine below reaches
 * `supported` only from an OBSERVED bounce — and a bounce can only reach our
 * own bounce server if the relay preserved the signed token in the envelope
 * sender byte for byte, because that token IS the address the DSN goes to. A
 * rewrite therefore presents as SILENCE: the probe ages out and settles
 * `unsupported`. This mirrors the shipped loopback probe
 * (`deliverabilityLoopbackAttempts`), which likewise only reaches `passed`
 * from a correlated inbound observation.
 *
 * Pure module: no db, no clock, no env. Every input is a parameter.
 */

import {
	sendProviderCatalogEntry,
	type DeclaredCustomReturnPathSupport,
	type SendProviderKind,
} from './catalog';

// ─── Probe state machine ───────────────────────────────────────────────────

/**
 * Lifecycle of ONE return-path probe for ONE configured transport.
 *
 *   awaiting_delivery  the relay accepted our MAIL FROM; nothing proven yet
 *   supported          a bounce for the probe reached OUR bounce server
 *   unsupported        the relay refused our MAIL FROM, or the probe aged out
 *                      without a bounce ever arriving (which is how a rewritten
 *                      envelope sender presents — the DSN goes elsewhere)
 */
export const RETURN_PATH_PROBE_STATUSES = [
	'awaiting_delivery',
	'supported',
	'unsupported',
] as const;
export type ReturnPathProbeStatus = (typeof RETURN_PATH_PROBE_STATUSES)[number];

/** Why a probe ended where it did. Rendered to operators verbatim. */
export const RETURN_PATH_PROBE_REASONS = [
	'awaiting_delivery',
	'observed_match',
	'rejected_by_relay',
	'no_bounce_observed',
] as const;
export type ReturnPathProbeReason = (typeof RETURN_PATH_PROBE_REASONS)[number];

/**
 * A verdict a probe already reached, carried across a later RE-PROBE.
 *
 * A re-probe reopens the row (`awaiting_delivery`), and an open probe resolves
 * to `unknown` — so without this, a relay PROVEN to honour our return path
 * would stop being stamped for up to {@link RETURN_PATH_PROBE_TIMEOUT_MS} every
 * time its TTL came round: relayed bounces in that window would be
 * unattributable and the cell would silently flip to degraded, twelve times a
 * year. The re-probe periodically switching OFF the very stamp it exists to
 * confirm is the opposite of what it is for.
 */
export interface SettledReturnPathVerdict {
	readonly status: Exclude<ReturnPathProbeStatus, 'awaiting_delivery'>;
	// `awaiting_delivery` is the reason of a probe still in flight; a SETTLED
	// verdict can never carry it, so the type does not admit it either.
	readonly reason: Exclude<ReturnPathProbeReason, 'awaiting_delivery'>;
	readonly settledAt: number;
}

export interface ReturnPathProbeState {
	readonly status: ReturnPathProbeStatus;
	readonly reason: ReturnPathProbeReason;
	/** The envelope sender we asked the relay to use. */
	readonly sentEnvelopeSender: string;
	/** When the probe was put on the wire. */
	readonly startedAt: number;
	/** When the status last changed. */
	readonly settledAt?: number;
	/**
	 * How many probes this transport has had. Drives the retry BACKOFF: every
	 * probe deliberately manufactures a bounce on the operator's relay, and a
	 * fixed daily retry against a relay that will never support us is one
	 * deliberate hard bounce a day, forever, on an account whose bounce rate can
	 * get the operator suspended. Legacy rows carry no count and are read as 1.
	 *
	 * It counts CONSECUTIVE probes since the last `supported` verdict, not every
	 * probe the transport has ever had — see {@link nextProbeAttempts}. Counting
	 * the latter would push a long-supported relay to the 30d cap, so the day it
	 * broke its documented "1st retry: next day" would in fact be a month.
	 */
	readonly attempts?: number;
	/**
	 * The verdict this transport last SETTLED on, kept while a re-probe is open
	 * so a proven relay keeps its stamp. Replaced (not merged) when the new probe
	 * settles; absent until a first verdict exists.
	 */
	readonly lastSettled?: SettledReturnPathVerdict;
}

export type ReturnPathProbeEvent =
	/** The relay's SMTP conversation accepted (or refused) MAIL FROM. */
	| { readonly kind: 'submitted'; readonly accepted: boolean; readonly at: number }
	/**
	 * A bounce for the probe reached OUR bounce server. Arrival IS the evidence
	 * — the signed VERP token lives in the address the DSN was sent to, so a
	 * relay that rewrote (or merely case-folded) the envelope sender routes the
	 * DSN somewhere else entirely and we observe nothing. There is deliberately
	 * no observed-address payload: no production source could supply one that
	 * differed, so comparing it would be a tautology dressed up as a check.
	 */
	| { readonly kind: 'observed'; readonly at: number }
	/** The probe aged out with nothing observed. */
	| { readonly kind: 'expired'; readonly at: number };

/** How long a probe waits for its bounce before it is called unsupported. */
export const RETURN_PATH_PROBE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h

/** How long a settled verdict is trusted before the transport is re-probed. */
export const RETURN_PATH_PROBE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/**
 * How soon an UNSUPPORTED verdict is retried, by attempt number.
 *
 * A probe is not free: it deliberately manufactures a bounce ON THE OPERATOR'S
 * RELAY, and a relay's bounce rate is exactly what gets an ESP account
 * suspended. A relay that does not honour a custom return path today usually
 * will not tomorrow either, so retrying it daily forever spends the operator's
 * sender reputation to re-learn a fact we already know. Back off instead:
 * a config change is still detected, just at a cost of one bounce a month
 * rather than 365.
 *
 * The last entry repeats — this is the cap. We never stop entirely, because a
 * transport frozen at `unsupported` forever could never recover from an
 * operator fixing their relay.
 */
export const RETURN_PATH_PROBE_RETRY_SCHEDULE_MS = [
	24 * 60 * 60 * 1000, // 1st retry: next day
	7 * 24 * 60 * 60 * 1000, // 2nd retry: next week
	30 * 24 * 60 * 60 * 1000, // thereafter: monthly (the cap)
] as const;

/** The FIRST retry interval — the shortest wait any unsupported verdict gets. */
export const RETURN_PATH_PROBE_RETRY_MS: number = RETURN_PATH_PROBE_RETRY_SCHEDULE_MS[0];

/** Retry interval for the Nth (1-based) settled attempt. */
export function returnPathProbeRetryMs(attempts: number | undefined): number {
	// ONE normalisation, applied to the argument itself: a missing, non-numeric
	// or non-finite count is the first attempt. (Testing `Number.isFinite` on the
	// possibly-undefined argument made the legacy-row rule hold by accident.)
	const n =
		typeof attempts === 'number' && Number.isFinite(attempts)
			? Math.max(1, Math.trunc(attempts))
			: 1;
	const capped = Math.min(n - 1, RETURN_PATH_PROBE_RETRY_SCHEDULE_MS.length - 1);
	return RETURN_PATH_PROBE_RETRY_SCHEDULE_MS[capped] ?? RETURN_PATH_PROBE_RETRY_MS;
}

/**
 * The verdict a transport currently STANDS ON, whether or not a re-probe is in
 * flight: the row's own status once it has settled, otherwise the verdict it
 * carried into the open probe. `undefined` ⇒ never settled anything.
 */
export function settledVerdictOf(
	state: ReturnPathProbeState | null | undefined
): SettledReturnPathVerdict | undefined {
	if (!state) return undefined;
	if (state.status === 'awaiting_delivery') return state.lastSettled;
	// A settled row cannot legitimately carry the in-flight reason. Rewriting one
	// that does into `no_bounce_observed` would present the operator with a
	// reason the system never observed; reporting NO verdict instead makes the
	// transport read as never-settled, so it is simply re-probed and the answer
	// comes from evidence rather than from laundering a corrupt row.
	if (state.reason === 'awaiting_delivery') return undefined;
	return {
		status: state.status,
		reason: state.reason,
		settledAt: state.settledAt ?? state.startedAt,
	};
}

/**
 * The attempt number a NEW probe for this transport should carry.
 *
 * Counts consecutive probes since the last `supported` verdict: a relay that is
 * currently proven starts over at 1, so if it later breaks it gets the schedule
 * its docstring promises (next day, then next week, then monthly) rather than
 * inheriting a count accumulated over a year of successful TTL re-checks. A
 * non-finite legacy count is read as none.
 */
export function nextProbeAttempts(previous: ReturnPathProbeState | null | undefined): number {
	if (settledVerdictOf(previous)?.status === 'supported') return 1;
	const raw = previous?.attempts;
	const base = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
	return base + 1;
}

/**
 * Advance a probe. Total and deterministic: an event that cannot apply (a late
 * observation for an already-settled probe, an expiry after a verdict) returns
 * the state unchanged rather than throwing.
 */
export function nextProbeState(
	state: ReturnPathProbeState,
	event: ReturnPathProbeEvent
): ReturnPathProbeState {
	if (state.status !== 'awaiting_delivery') return state;

	switch (event.kind) {
		case 'submitted':
			// Acceptance proves nothing on its own — it only keeps the probe open.
			return event.accepted
				? state
				: {
						...state,
						status: 'unsupported',
						reason: 'rejected_by_relay',
						settledAt: event.at,
					};
		case 'observed':
			// THE point of the probe: the DSN came back to the address we set, so
			// the relay preserved our envelope sender. A relay that rewrote it
			// cannot reach here at all — it settles through 'expired' instead.
			return {
				...state,
				status: 'supported',
				reason: 'observed_match',
				settledAt: event.at,
			};
		case 'expired':
			return {
				...state,
				status: 'unsupported',
				reason: 'no_bounce_observed',
				settledAt: event.at,
			};
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

/**
 * Elapsed time between two instants, or `null` when either is unusable.
 *
 * A NaN or Infinite timestamp (a corrupt row, a skewed clock, a hand-written
 * fixture) makes every `>=` comparison FALSE, which would wedge the scheduler
 * permanently: the open probe never times out, the transport is never
 * re-probed, and the capability is stuck at `unknown` with no path to recovery.
 * Callers treat `null` as "assume it is due", so a degenerate row heals itself
 * on the next sweep instead of becoming a silent dead end.
 */
function elapsedSince(instant: number, now: number): number | null {
	if (!Number.isFinite(instant) || !Number.isFinite(now)) return null;
	return now - instant;
}

/** Has an open probe waited longer than the timeout? Degenerate ⇒ yes. */
export function isProbeTimedOut(state: ReturnPathProbeState, now: number): boolean {
	if (state.status !== 'awaiting_delivery') return false;
	const elapsed = elapsedSince(state.startedAt, now);
	return elapsed === null || elapsed >= RETURN_PATH_PROBE_TIMEOUT_MS;
}

/**
 * Is it time to (re-)probe this transport? Never probed → yes. Open probe →
 * no (one in flight is enough) until it times out. Supported → after the TTL.
 * Unsupported → after a BACKING-OFF retry interval, because relay configuration
 * does change but each probe costs the operator a real bounce.
 *
 * A degenerate timestamp is due, never wedged (see {@link elapsedSince}).
 */
export function isProbeDue(state: ReturnPathProbeState | null, now: number): boolean {
	if (!state) return true;
	if (state.status === 'awaiting_delivery') return isProbeTimedOut(state, now);
	const elapsed = elapsedSince(state.settledAt ?? state.startedAt, now);
	if (elapsed === null) return true;
	const interval =
		state.status === 'supported'
			? RETURN_PATH_PROBE_TTL_MS
			: returnPathProbeRetryMs(state.attempts);
	return elapsed >= interval;
}

// ─── Resolved capability ───────────────────────────────────────────────────

/**
 * `unknown` is a first-class outcome, not an error: a relay we have not
 * finished probing is treated exactly like one that does not support a custom
 * return path — we simply do not stamp one, and we mark the measurement
 * degraded.
 */
export type ReturnPathCapability = 'supported' | 'unsupported' | 'unknown';

export type MeasurementQuality = 'comparable' | 'degraded';

/**
 * Multiplier applied to a bounce-gate tolerance when the arm's bounce data
 * does not come from our own VERP stream.
 *
 * Provider feedback (SES/Resend webhooks) is real data with different
 * coverage, so it is widened modestly. No feedback at all means the only
 * bounce evidence is the relay's SMTP-time rejections, which under-reports
 * badly — widen hard rather than let a flattering number drive an increase.
 */
export const BOUNCE_TOLERANCE_MULTIPLIER_COMPARABLE = 1;
export const BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK = 2;
export const BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK = 4;

/**
 * The resolved posture. `capability` is the ONE bit: whether this transport is
 * proven to honour a custom return path. Everything a consumer wants to know
 * from it — may we stamp, is the measurement degraded — is DERIVED from it by
 * the helpers below rather than stored alongside it, because four stored fields
 * that can only ever agree are four chances to disagree.
 */
export interface ResolvedReturnPathCapability {
	readonly capability: ReturnPathCapability;
	readonly bounceToleranceMultiplier: number;
	readonly declared: DeclaredCustomReturnPathSupport;
	readonly probeStatus: ReturnPathProbeStatus | 'never_probed';
	readonly reason: ReturnPathProbeReason | 'declared_supported' | 'declared_unsupported';
}

/**
 * Fold the catalog's declared support and the observed probe (if any) into the
 * one answer both the send path and the gates read. Total: any combination of
 * inputs — including a stale probe, a probe for a transport whose declaration
 * changed, or no probe at all — resolves to a usable posture.
 */
export function resolveReturnPathCapability(
	kind: SendProviderKind,
	probe: ReturnPathProbeState | null,
	now: number
): ResolvedReturnPathCapability {
	return resolveReturnPathCapabilityForEntry(sendProviderCatalogEntry(kind), probe, now);
}

/** The two catalog fields the resolution actually depends on. */
export type ReturnPathCatalogDeclaration = Readonly<{
	supportsCustomReturnPath?: DeclaredCustomReturnPathSupport;
	hasProviderFeedback?: boolean;
}>;

/**
 * The same resolution against a DECLARATION rather than a catalogued kind.
 *
 * Exists so the fail-closed path — a transport (a plugin-contributed one, or a
 * future core kind) that declares NOTHING — is testable against an explicit
 * fixture instead of depending on the bundled catalog happening to contain an
 * undeclared entry. A test that searches the live catalog for such an entry
 * passes vacuously the day every entry declares one.
 */
export function resolveReturnPathCapabilityForEntry(
	entry: ReturnPathCatalogDeclaration,
	probe: ReturnPathProbeState | null,
	now: number
): ResolvedReturnPathCapability {
	const declared: DeclaredCustomReturnPathSupport = entry.supportsCustomReturnPath ?? 'no';
	const hasProviderFeedback = entry.hasProviderFeedback ?? false;

	if (declared === 'yes') {
		return grade('supported', declared, probe?.status ?? 'never_probed', 'declared_supported', {
			hasProviderFeedback,
		});
	}
	if (declared === 'no') {
		return grade('unsupported', declared, probe?.status ?? 'never_probed', 'declared_unsupported', {
			hasProviderFeedback,
		});
	}

	// declared === 'probe' — the observed verdict decides, and only a fresh one.
	if (!probe) {
		return grade('unknown', declared, 'never_probed', 'awaiting_delivery', {
			hasProviderFeedback,
		});
	}
	if (probe.status === 'awaiting_delivery') {
		// A RE-probe must not revoke the verdict it is re-checking. While the probe
		// is legitimately open (it has not aged past the timeout — a degenerate
		// clock reads as timed out, so it can never pin a stale verdict forever)
		// the transport stands on what it last settled; the new probe replaces that
		// only once IT settles. The carry is bounded by the timeout, so a broken
		// relay is demoted within RETURN_PATH_PROBE_TIMEOUT_MS of its TTL, not
		// indefinitely.
		// Evidence is judged by ONE rule everywhere in this function: a timestamp
		// must be finite AND not in the future (a skewed clock is not evidence),
		// the same test the freshness check below applies to a settled row.
		const carried = probe.lastSettled;
		const carriedAge = carried ? now - carried.settledAt : Number.NaN;
		if (carried && Number.isFinite(carriedAge) && carriedAge >= 0 && !isProbeTimedOut(probe, now)) {
			return grade(carried.status, declared, probe.status, carried.reason, {
				hasProviderFeedback,
			});
		}
		return grade('unknown', declared, probe.status, 'awaiting_delivery', { hasProviderFeedback });
	}
	const settledAt = probe.settledAt ?? probe.startedAt;
	// A verdict older than its TTL (or one from a clock-skewed future) is no
	// longer evidence; fall back to `unknown`, which behaves like unsupported.
	// A non-finite age (NaN timestamps from a corrupt row or a skewed clock) is
	// no evidence either — never let it read as a fresh verdict.
	const age = now - settledAt;
	if (!Number.isFinite(age) || age < 0 || age >= RETURN_PATH_PROBE_TTL_MS) {
		return grade('unknown', declared, probe.status, probe.reason, { hasProviderFeedback });
	}
	return grade(
		probe.status === 'supported' ? 'supported' : 'unsupported',
		declared,
		probe.status,
		probe.reason,
		{ hasProviderFeedback }
	);
}

function grade(
	capability: ReturnPathCapability,
	declared: DeclaredCustomReturnPathSupport,
	probeStatus: ReturnPathProbeStatus | 'never_probed',
	reason: ResolvedReturnPathCapability['reason'],
	options: { hasProviderFeedback: boolean }
): ResolvedReturnPathCapability {
	const supported = capability === 'supported';
	return {
		capability,
		bounceToleranceMultiplier: supported
			? BOUNCE_TOLERANCE_MULTIPLIER_COMPARABLE
			: options.hasProviderFeedback
				? BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK
				: BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK,
		declared,
		probeStatus,
		reason,
	};
}

/**
 * The posture for a transport we cannot resolve AT ALL — an id this deployment
 * no longer configures. Same shape, same grading function, so it can never
 * drift from what {@link resolveReturnPathCapability} returns for a transport
 * that simply has no evidence yet. Never an error (plan D2).
 */
export const unresolvableReturnPathCapability: ResolvedReturnPathCapability = Object.freeze(
	grade('unknown', 'probe', 'never_probed', 'awaiting_delivery', { hasProviderFeedback: false })
);

/**
 * Is this transport proven to honour a custom return path — i.e. may the send
 * path stamp our VERP envelope sender on it, and is its bounce data comparable
 * with the direct-MX arm's? `unknown` behaves exactly like `unsupported`.
 *
 * The one derived predicate, so a consumer can never set "supported" and
 * "comparable" to different answers.
 */
export function isCustomReturnPathSupported(
	resolved: Pick<ResolvedReturnPathCapability, 'capability'>
): boolean {
	return resolved.capability === 'supported';
}

/** Measurement confidence for a cell sending through this transport. */
export function measurementQualityOf(
	resolved: Pick<ResolvedReturnPathCapability, 'capability'>
): MeasurementQuality {
	return isCustomReturnPathSupported(resolved) ? 'comparable' : 'degraded';
}

/**
 * Widen a bounce-gate tolerance for a degraded arm. Separate from the gate
 * itself so the gate stays a pure comparison and the widening is pinned by its
 * own fixtures. Non-finite or negative inputs pass through unchanged rather
 * than producing a NaN threshold that would silently fail every comparison.
 */
export function widenBounceTolerance(
	baseTolerance: number,
	resolved: Pick<ResolvedReturnPathCapability, 'bounceToleranceMultiplier'>
): number {
	if (!Number.isFinite(baseTolerance) || baseTolerance < 0) return baseTolerance;
	return baseTolerance * resolved.bounceToleranceMultiplier;
}
