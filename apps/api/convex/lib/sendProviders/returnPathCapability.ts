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
 * The reviewer's question — "what about a relay that ACCEPTS our MAIL FROM and
 * silently rewrites it?" — is why acceptance alone is NOT a verdict. The probe
 * state machine below only reaches `supported` from an OBSERVED delivered
 * bounce whose envelope sender still matches what we sent, mirroring the
 * shipped loopback probe (`deliverabilityLoopbackAttempts`), which likewise
 * only reaches `passed` from a correlated inbound observation.
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
 *   supported          a delivered bounce carried the envelope sender we set
 *   unsupported        the relay refused it, or rewrote it, or the probe aged
 *                      out without a bounce ever arriving
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
	'rewritten_by_relay',
	'rejected_by_relay',
	'no_bounce_observed',
] as const;
export type ReturnPathProbeReason = (typeof RETURN_PATH_PROBE_REASONS)[number];

export interface ReturnPathProbeState {
	readonly status: ReturnPathProbeStatus;
	readonly reason: ReturnPathProbeReason;
	/** The envelope sender we asked the relay to use. */
	readonly sentEnvelopeSender: string;
	/** What actually came back, once anything did. */
	readonly observedEnvelopeSender?: string;
	/** When the probe was put on the wire. */
	readonly startedAt: number;
	/** When the status last changed. */
	readonly settledAt?: number;
}

export type ReturnPathProbeEvent =
	/** The relay's SMTP conversation accepted (or refused) MAIL FROM. */
	| { readonly kind: 'submitted'; readonly accepted: boolean; readonly at: number }
	/** A bounce for the probe arrived; this is the envelope sender it carried. */
	| { readonly kind: 'observed'; readonly envelopeSender: string; readonly at: number }
	/** The probe aged out with nothing observed. */
	| { readonly kind: 'expired'; readonly at: number };

/** How long a probe waits for its bounce before it is called unsupported. */
export const RETURN_PATH_PROBE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h

/** How long a settled verdict is trusted before the transport is re-probed. */
export const RETURN_PATH_PROBE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** How soon an UNSUPPORTED verdict is retried (relay config changes). */
export const RETURN_PATH_PROBE_RETRY_MS = 24 * 60 * 60 * 1000; // 24h

/** Case/whitespace-insensitive envelope-sender comparison (RFC 5321 domains
 *  are case-insensitive; we generate lower-case local parts ourselves). */
function sameEnvelopeSender(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
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
			// THE point of the probe: a relay may accept our MAIL FROM and rewrite
			// it to its own bounce address. A mismatch is unsupported, not trusted.
			return sameEnvelopeSender(event.envelopeSender, state.sentEnvelopeSender)
				? {
						...state,
						status: 'supported',
						reason: 'observed_match',
						observedEnvelopeSender: event.envelopeSender,
						settledAt: event.at,
					}
				: {
						...state,
						status: 'unsupported',
						reason: 'rewritten_by_relay',
						observedEnvelopeSender: event.envelopeSender,
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

/** Has an open probe waited longer than the timeout? */
export function isProbeTimedOut(state: ReturnPathProbeState, now: number): boolean {
	return (
		state.status === 'awaiting_delivery' && now - state.startedAt >= RETURN_PATH_PROBE_TIMEOUT_MS
	);
}

/**
 * Is it time to (re-)probe this transport? Never probed → yes. Open probe →
 * no (one in flight is enough). Supported → after the TTL. Unsupported →
 * after the shorter retry interval, because relay configuration changes.
 */
export function isProbeDue(state: ReturnPathProbeState | null, now: number): boolean {
	if (!state) return true;
	if (state.status === 'awaiting_delivery') return isProbeTimedOut(state, now);
	const settledAt = state.settledAt ?? state.startedAt;
	const interval =
		state.status === 'supported' ? RETURN_PATH_PROBE_TTL_MS : RETURN_PATH_PROBE_RETRY_MS;
	return now - settledAt >= interval;
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

export interface ResolvedReturnPathCapability {
	readonly capability: ReturnPathCapability;
	/** May the send path stamp our VERP envelope sender on this transport? */
	readonly stampVerpReturnPath: boolean;
	readonly measurement: MeasurementQuality;
	/** True ⇒ surface "measurement confidence: low" on cells using this arm. */
	readonly degraded: boolean;
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
	const entry = sendProviderCatalogEntry(kind);
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
		stampVerpReturnPath: supported,
		measurement: supported ? 'comparable' : 'degraded',
		degraded: !supported,
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
