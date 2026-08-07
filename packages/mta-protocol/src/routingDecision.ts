/**
 * The `POST /send/decision` wire — the last-mile routing conversation between
 * Convex's governed dispatch and the MTA's routing governance (D7).
 *
 * The REQUEST's vocabulary was already one declaration — `GovernedRoutingContext`
 * in `@owlat/shared`, which the MTA's handler validated against — but Convex's
 * producer restated all eleven fields inline, so the two ends were only
 * structurally related. {@link MtaRoutingDecisionRequest} names the body once
 * and BOTH ends are typed against it now.
 *
 * This module also owns the ANSWER, which until now was emitted as JSON
 * literals in `apps/mta/src/routes/routingDecision.ts` and re-declared —
 * accept-list, reason union, defer-origin table and all — in
 * `apps/api/convex/lib/sendProviders/mta/index.ts`. Two declarations of one
 * wire, whose own comment admitted the drift risk. This is the one.
 */

import type { GovernedRoutingContext } from '@owlat/shared/routingDispatch';

/** The decision request body. `requireProviderProbe` is the one optional knob. */
export type MtaRoutingDecisionRequest = GovernedRoutingContext & {
	requireProviderProbe?: boolean;
};

/**
 * WHO DECIDED TO DEFER — the MTA's routing governance, or a fault on our own
 * side. Both shapes are `defer` to the caller (the message waits either way),
 * but only `governed` is a statement about whether this sending identity may
 * send.
 */
export type MtaDeferOrigin = 'governed' | 'local';

/**
 * EVERY defer reason the MTA may answer, each paired with WHOSE FAULT IT IS.
 *
 * One table, two jobs, so the accept-list and the classification cannot drift
 * apart: a reason absent here is an answer Convex did not understand and falls
 * through to the unrecognised-body return, and a reason added here cannot be
 * added without naming an origin. Since D7 it is also the table the MTA'S OWN
 * HANDLER types its `defer` answers against, so the two ends change together
 * or one of them stops compiling.
 *
 * `governed` is the MTA declining this SENDING IDENTITY — an open global safety
 * circuit, a probe budget, no warmed IP to send from. `lease_persistence` is
 * none of those: it is ANY REDIS FAILURE WHILE TAKING THE LEASE — reserving a
 * half-open probe, writing the lease record, whatever the one catch in
 * `apps/mta/src/routes/routingDecision.ts` covers — so it is our own storage
 * layer failing and no receiver ever refused the mail. Gate 2 halts a cell at
 * 25% of `governed` deferrals; a Redis outage on our own MTA must not be able to
 * spend that budget.
 */
export const MTA_DEFER_REASON_ORIGIN = {
	global_safety: 'governed',
	global_probe: 'governed',
	no_owned_ip: 'governed',
	lease_persistence: 'local',
} as const satisfies Record<string, MtaDeferOrigin>;

export type MtaDeferReason = keyof typeof MTA_DEFER_REASON_ORIGIN;

/**
 * Classify one answered defer reason, or `undefined` for a reason nobody
 * vouched for. `hasOwnProperty` rather than truthiness so `constructor` and
 * `__proto__` cannot be answered as recognised reasons.
 */
export function mtaDeferReasonOrigin(reason: unknown): MtaDeferOrigin | undefined {
	if (typeof reason !== 'string') return undefined;
	if (!Object.prototype.hasOwnProperty.call(MTA_DEFER_REASON_ORIGIN, reason)) return undefined;
	return MTA_DEFER_REASON_ORIGIN[reason as MtaDeferReason];
}

/**
 * Every reason the MTA may attach to a `relay` answer — each one a
 * provider-local condition that leaves the identity itself in good standing.
 * A bare `{ decision: 'relay' }` (no reason) is the answer to a request that
 * NAMED relay as its candidate provider, and carries no reason because none of
 * these applies.
 *
 * Like {@link MTA_DEFER_REASON_ORIGIN}, this is BOTH the type's source and the
 * accept-list Convex validates an answer against ({@link
 * isMtaRelayDecisionReason}) — a reason added here reaches both ends at once, so
 * the emitter and the validator cannot drift into a relay answer the reader
 * silently turns into a 60-second defer.
 */
export const MTA_RELAY_DECISION_REASONS = [
	'provider_breaker',
	'provider_probe_limit',
	'provider_hysteresis',
	'warmup_overflow',
] as const;

export type MtaRelayDecisionReason = (typeof MTA_RELAY_DECISION_REASONS)[number];

const RELAY_DECISION_REASONS = new Set<string>(MTA_RELAY_DECISION_REASONS);

/** Recognise one answered relay reason. A `Set`, so no inherited key matches. */
export function isMtaRelayDecisionReason(reason: unknown): reason is MtaRelayDecisionReason {
	return typeof reason === 'string' && RELAY_DECISION_REASONS.has(reason);
}

/** The authenticated last-mile lease the MTA grants with an `mta` decision. */
export interface MtaRoutingLeaseGrant {
	token: string;
	providerProbe: boolean;
	globalProbe: boolean;
}

/**
 * The answer ON THE WIRE, exactly as the MTA serialises it.
 *
 * Convex validates every one of these shapes EXACTLY (key counts included), so
 * a field added here without being added there is rejected as an answer we did
 * not understand — the safe direction, and never a silent one.
 */
export type MtaRoutingDecisionResponse =
	| { decision: 'mta'; lease: MtaRoutingLeaseGrant }
	| { decision: 'relay' }
	| { decision: 'relay'; reason: MtaRelayDecisionReason }
	| { decision: 'defer'; reason: MtaDeferReason; retryAfterMs: number };

/**
 * The reason Convex records for a relay answer that carried none — the MTA
 * permitting the relay candidate it was asked about. Not a wire literal: the
 * MTA never sends it, Convex synthesises it so every relay decision it holds
 * names a reason.
 */
export const MTA_RELAY_ALLOWED_REASON = 'relay_allowed';

/**
 * The decision AS CONVEX HOLDS IT once the wire answer is validated: the same
 * three outcomes, with the lease unpacked, the reason-less relay answer named,
 * and the defer carrying the origin its reason classifies to.
 */
export type MtaRoutingDecision =
	| { kind: 'mta'; leaseToken: string; isProviderProbe: boolean; isGlobalProbe: boolean }
	| { kind: 'relay'; reason: typeof MTA_RELAY_ALLOWED_REASON | MtaRelayDecisionReason }
	| {
			kind: 'defer';
			retryAfterMs: number;
			/**
			 * An unconfigured, unreachable, slow or malformed decision endpoint is
			 * `local`, and so is an ANSWER that reports our own infrastructure failing
			 * rather than the identity's standing ({@link MTA_DEFER_REASON_ORIGIN}) —
			 * the receiver saw neither. `delivery/deferralOutcome.ts` counts the first
			 * and skips the second, so an outage on our side cannot halt a cell for a
			 * fortnight.
			 */
			origin: MtaDeferOrigin;
	  };
