/**
 * Redacted shape + validators for signed-hook DELIVERY LOGS (Tier 2, PP-25).
 *
 * PURE and V8-safe (only `convex/values` + types) so the schema module can import
 * the validators without pulling a Node runtime in. The delivery log is a
 * diagnostic record of every {@link import('./hookRuntime').invokeHook} resolution
 * — attempts, timing, and the fallback reason — living ALONGSIDE the outbound
 * webhook delivery logs. It is redacted BY CONSTRUCTION: there is no field here
 * for the hook payload, the app's returned draft/gate/score text, the shared
 * secret, or the request/response signature, so no read path can leak them.
 *
 * REPLAY RULE: because none of the request/response bytes, secret, or signature
 * are retained, a logged delivery can never be replayed FROM the log. The only
 * "replay" is the pipeline re-invoking the hook through `invokeHook`, which signs
 * a fresh timestamp + nonce (the transport's replay defense forbids reusing the
 * old signed bytes) and re-runs the full restrict-only envelope — a replayed gate
 * can still only add caution, never approve or send.
 */

import { v, type Infer } from 'convex/values';
import type { HookUnavailableCode } from './hookOutcome';

/** The hook kinds a delivery can log — the same three PP-24 kinds. */
export const hookDeliveryKindValidator = v.union(
	v.literal('draft'),
	v.literal('gate'),
	v.literal('score')
);

/**
 * Whether the surfaced value came from the app or the declared safe fallback.
 * Mirrors {@link import('./hookOutcome').ConnectedAppHookOutcome.source}.
 */
export const hookDeliverySourceValidator = v.union(v.literal('app'), v.literal('fallback'));

/**
 * The reason a delivery fell back, drawn from the full
 * {@link HookUnavailableCode} taxonomy: the pre/post-network runtime codes AND
 * every transport failure code. Storing the FIXED taxonomy (never free text, and
 * never the app's own message) keeps the log both redacted and filterable.
 */
export const hookUnavailableCodeValidator = v.union(
	// Transport failure codes (hookClient.HookFailureCode).
	v.literal('request_too_large'),
	v.literal('blocked_ssrf'),
	v.literal('redirect_refused'),
	v.literal('timeout'),
	v.literal('network_error'),
	v.literal('bad_status'),
	v.literal('response_too_large'),
	v.literal('signature_missing'),
	v.literal('signature_mismatch'),
	v.literal('stale_response'),
	v.literal('invalid_json'),
	v.literal('invalid_response'),
	// Runtime codes resolved before or instead of a network call (hookOutcome).
	v.literal('app_not_found'),
	v.literal('app_disabled'),
	v.literal('app_revoked'),
	v.literal('capability_denied'),
	v.literal('circuit_open'),
	v.literal('secret_unavailable'),
	v.literal('output_rejected'),
	v.literal('unexpected_error')
);

/** The literal union the validator accepts. */
type ValidatorUnavailableCode = Infer<typeof hookUnavailableCodeValidator>;

// Compile-time completeness in BOTH directions: if a new HookUnavailableCode is
// added (or an obsolete literal lingers) the validator must be updated in lock
// step, or this fails to type-check. The log's fallback-reason column has to
// cover exactly the codes the runtime can produce.
type _MissingFromValidator = Exclude<HookUnavailableCode, ValidatorUnavailableCode>;
type _ExtraInValidator = Exclude<ValidatorUnavailableCode, HookUnavailableCode>;
const _hookCodeTaxonomyIsExhaustive: [_MissingFromValidator, _ExtraInValidator] extends [never, never]
	? true
	: false = true;
void _hookCodeTaxonomyIsExhaustive;
