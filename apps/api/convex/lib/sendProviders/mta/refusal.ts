/**
 * Decoding the MTA's `/send` refusal body (`{ error, code, retryAfterMs? }`).
 *
 * The `code` is the machine-readable answer and the `error` is prose for a
 * person, so classification reads the code and never the prose: rewording an
 * MTA message cannot change what Convex does with it, and a message that
 * happens to quote a code cannot pass for one.
 */

import { ROUTING_LEASE_UNREADABLE_CODE } from '@owlat/shared';
import { isMtaSendErrorCode } from '@owlat/mta-protocol/send';

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
 * How a 409 refusal reads. `lease_unreadable` is the MTA's own lease store
 * failing, kept apart from `decision_deferred` (a stale or changed decision, a
 * safety pause) because only the latter is evidence about the sending
 * identity. `intake_pending` means the MTA may still accept the message.
 * `refused` is any other decoded code (a missing lease, or a code this build
 * does not know): the code is the answer, so the prose beside it is never read.
 */
export type MtaConflict = 'lease_unreadable' | 'decision_deferred' | 'intake_pending' | 'refused';

/**
 * A body that carries no code: the codes as bare tokens anywhere in it, the
 * unreadable lease first. Deferring is the safe reading of a body this build
 * cannot decode, so such a body keeps the reading it always had.
 */
const UNCODED_LEASE_UNREADABLE = new RegExp(`\\b${ROUTING_LEASE_UNREADABLE_CODE}\\b`);
const UNCODED_DECISION_DEFERRED = /\b(?:ROUTING_DECISION_[A-Z0-9_]+|GLOBAL_SAFETY_DEFER)\b/;

/**
 * Read a 409 body. A decoded code always yields an answer, whatever the prose
 * says. `undefined` only for a body with no code and no routing token, which
 * the caller classifies like any other unexplained failure.
 *
 * Any `ROUTING_DECISION_*` code counts as a deferral, including one a newer
 * MTA build knows and this reader does not: an unrecognised routing refusal
 * must go back to the worker for a fresh decision, not down the generic 409
 * path. That is why this reads a prefix rather than the `MTA_SEND_ERROR_CODES`
 * accept-list.
 */
export function mtaConflictOf(body: string): MtaConflict | undefined {
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
	// Narrowed through the package's accept-list so that dropping the code from
	// `MTA_SEND_ERROR_CODES` stops this comparison compiling.
	if (isMtaSendErrorCode(code) && code === 'INTAKE_PENDING') return 'intake_pending';
	return 'refused';
}
