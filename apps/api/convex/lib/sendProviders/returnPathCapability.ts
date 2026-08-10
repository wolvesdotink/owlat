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
 * THIS module is the FOLD: catalog declaration + the transport's settled probe
 * (if any) ⇒ the one posture the send path and the gates read. The probe
 * lifecycle it folds — statuses, transitions, retry backoff, expiry — lives in
 * its sibling `returnPathProbe.ts`, and the invariant that makes the fold worth
 * trusting lives there with it: acceptance is not a verdict, `supported` is
 * reached only from an OBSERVED bounce, so a relay that rewrites our envelope
 * sender presents as silence and settles `unsupported`.
 *
 * Pure module: no db, no clock, no env. Every input is a parameter.
 */

import { hasProviderFeedbackOf, supportsCustomReturnPathOf } from '@owlat/shared';
import {
	sendProviderCatalogEntry,
	type DeclaredCustomReturnPathSupport,
	type SendProviderKind,
} from './catalog';
import {
	RETURN_PATH_PROBE_TTL_MS,
	isProbeTimedOut,
	type ReturnPathProbeReason,
	type ReturnPathProbeState,
	type ReturnPathProbeStatus,
} from './returnPathProbe';

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

/**
 * The two catalog fields the resolution actually depends on.
 *
 * A PARTIAL declaration on purpose — see {@link resolveReturnPathCapabilityForEntry}
 * — and both fields are read through `@owlat/shared`'s `…Of` accessors, which
 * accept exactly the field they read for this reason. Neither default is spelled
 * here: `supportsCustomReturnPath` absent ⇒ `no` and `hasProviderFeedback` absent
 * ⇒ `false` are the catalog's rules, stated once in
 * `packages/shared/src/sendProviderCapabilities.ts`, so tightening one there
 * moves this fold with it instead of leaving the sweep grading a plugin-
 * contributed transport by the old reading.
 */
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
	const declared: DeclaredCustomReturnPathSupport = supportsCustomReturnPathOf(entry);
	const hasProviderFeedback = hasProviderFeedbackOf(entry);

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
