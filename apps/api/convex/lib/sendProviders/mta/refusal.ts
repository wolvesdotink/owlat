/**
 * Decoding the MTA's `/send` refusal body (`{ error, code, retryAfterMs? }`).
 *
 * The `code` is the machine-readable answer and the `error` is prose for a
 * person, so classification reads the code and never the prose: rewording an
 * MTA message cannot change what Convex does with it, and a message that
 * happens to quote a code cannot pass for one.
 */

import { ROUTING_LEASE_UNREADABLE_CODE } from '@owlat/shared';

/** A refusal code as the MTA spells them: upper-case words joined by `_`. */
const REFUSAL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface MtaRefusal {
	code?: string;
	retryAfterMs?: number;
}

/** The fields of a refusal body. A body that is not a JSON object decodes empty. */
export function decodeMtaRefusal(body: string): MtaRefusal {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
	const record = parsed as Record<string, unknown>;
	const code = record['code'];
	const retryAfterMs = record['retryAfterMs'];
	return {
		...(typeof code === 'string' && REFUSAL_CODE_PATTERN.test(code) ? { code } : {}),
		...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
	};
}

/**
 * The two kinds of routing refusal. `lease_unreadable` is the MTA's own lease
 * store failing, kept apart from `decision_deferred` (a stale or changed
 * decision, a safety pause) because only the latter is evidence about the
 * sending identity.
 */
export type MtaRoutingRefusal = 'lease_unreadable' | 'decision_deferred';

/**
 * A body that carries no code: the codes as bare tokens anywhere in it, the
 * unreadable lease first. Deferring is the safe reading of a body this build
 * cannot decode, so such a body keeps the reading it always had.
 */
const UNCODED_LEASE_UNREADABLE = new RegExp(`\\b${ROUTING_LEASE_UNREADABLE_CODE}\\b`);
const UNCODED_DECISION_DEFERRED = /\b(?:ROUTING_DECISION_[A-Z0-9_]+|GLOBAL_SAFETY_DEFER)\b/;

/**
 * The routing refusal a 409 body carries, if any.
 *
 * Any `ROUTING_DECISION_*` code counts, including one a newer MTA build knows
 * and this reader does not: an unrecognised routing refusal must go back to
 * the worker for a fresh decision, not down the generic 409 path. That is why
 * this reads a prefix rather than the `MTA_SEND_ERROR_CODES` accept-list.
 */
export function mtaRoutingRefusalOf(body: string): MtaRoutingRefusal | undefined {
	const { code } = decodeMtaRefusal(body);
	if (code === undefined) {
		if (UNCODED_LEASE_UNREADABLE.test(body)) return 'lease_unreadable';
		if (UNCODED_DECISION_DEFERRED.test(body)) return 'decision_deferred';
		return undefined;
	}
	if (code === ROUTING_LEASE_UNREADABLE_CODE) return 'lease_unreadable';
	if (code.startsWith('ROUTING_DECISION_') || code === 'GLOBAL_SAFETY_DEFER') {
		return 'decision_deferred';
	}
	return undefined;
}
