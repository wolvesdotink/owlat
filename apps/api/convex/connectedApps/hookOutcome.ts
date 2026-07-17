/**
 * The consumer-facing outcome of a signed synchronous hook, plus the DECLARED
 * SAFE FALLBACK for each kind (Tier 2). PURE and V8-safe.
 *
 * Every hook resolves to one of these, whether the connected app answered or
 * anything went wrong (disabled app, open circuit, timeout, bad signature,
 * malformed body, …). The fallbacks are fixed by the protocol — a plugin cannot
 * choose them — and encode the fail direction the security model requires:
 *
 *   - `gate`  fails CLOSED: the outcome ALWAYS carries a `RestrictOnlyGateResult`,
 *     and any failure yields an `objection` (adds caution → routes to human
 *     review). A gate can never produce approval; a failure never relaxes one.
 *   - `draft` fails OPEN: a failure yields `draft: null`, meaning "use the
 *     built-in default strategy". Drafting is advisory, so an unavailable app
 *     must not block a reply.
 *   - `score` fails OPEN: a failure yields `score: null`, meaning "no score
 *     contributed". A score is advisory input, never a gate.
 *
 * `source: 'app'` marks a value the (authenticated, validated, scrubbed) app
 * actually returned; `source: 'fallback'` marks the declared default, with the
 * `failureCode` that triggered it.
 */

import type { RestrictOnlyGateResult } from '@owlat/plugin-host';
import type { HookFailureCode } from './hookClient';

/**
 * Why a hook did not yield a usable app value. Extends the transport failure
 * codes with the reasons the runtime resolves BEFORE (or INSTEAD OF) a network
 * call, so logging and tests can distinguish "never called" from "called and
 * failed".
 */
export type HookUnavailableCode =
	| HookFailureCode
	| 'app_not_found'
	| 'app_disabled'
	| 'app_revoked'
	| 'circuit_open'
	| 'secret_unavailable'
	| 'output_rejected'
	| 'unexpected_error';

export type DraftHookOutcome =
	| { readonly hookKind: 'draft'; readonly source: 'app'; readonly draft: string }
	| {
			readonly hookKind: 'draft';
			readonly source: 'fallback';
			readonly draft: null;
			readonly failureCode: HookUnavailableCode;
	  };

export interface GateHookOutcome {
	readonly hookKind: 'gate';
	readonly source: 'app' | 'fallback';
	readonly gate: RestrictOnlyGateResult;
	readonly failureCode?: HookUnavailableCode;
}

export type ScoreHookOutcome =
	| {
			readonly hookKind: 'score';
			readonly source: 'app';
			readonly score: number;
			readonly reason?: string;
	  }
	| {
			readonly hookKind: 'score';
			readonly source: 'fallback';
			readonly score: null;
			readonly failureCode: HookUnavailableCode;
	  };

export type ConnectedAppHookOutcome = DraftHookOutcome | GateHookOutcome | ScoreHookOutcome;

/** The host-authored caution an unavailable gate contributes. Never plugin text. */
export const GATE_FALLBACK_OBJECTION =
	'A connected-app gate is unavailable; not auto-sending — routing to human review.';

/** Draft fails open: use the built-in default strategy. */
export function draftFallback(failureCode: HookUnavailableCode): DraftHookOutcome {
	return { hookKind: 'draft', source: 'fallback', draft: null, failureCode };
}

/** Gate fails closed: contribute a caution objection (restrict-only). */
export function gateFallback(failureCode: HookUnavailableCode): GateHookOutcome {
	return {
		hookKind: 'gate',
		source: 'fallback',
		gate: { outcome: 'objection', reason: GATE_FALLBACK_OBJECTION },
		failureCode,
	};
}

/** Score fails open: no score contributed. */
export function scoreFallback(failureCode: HookUnavailableCode): ScoreHookOutcome {
	return { hookKind: 'score', source: 'fallback', score: null, failureCode };
}

/** The declared safe fallback for `hookKind`, tagged with why it fired. */
export function hookFallback(
	hookKind: 'draft' | 'gate' | 'score',
	failureCode: HookUnavailableCode
): ConnectedAppHookOutcome {
	switch (hookKind) {
		case 'draft':
			return draftFallback(failureCode);
		case 'gate':
			return gateFallback(failureCode);
		case 'score':
			return scoreFallback(failureCode);
	}
}
