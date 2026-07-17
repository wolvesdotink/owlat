/**
 * Phase: classify the inbound mail as FBL/ARF complaint, attributed DSN
 * bounce, or unattributed DSN bounce.
 *
 * The duplicate-complaint check is intrinsic to FBL classification (an
 * already-seen complaint is silently ACKed). The check uses Redis `SET NX`
 * — both a check and a claim in one atomic op — so it lives inside this
 * phase rather than as a separate "redis_dedup" effect.
 *
 * On `continue`, the ctx is unchanged and the next phase (`resolveRoute`)
 * decides whether this is a mailbox delivery, a routed inbound, or
 * unrecognized.
 */

import { tryParseARF, isDuplicateComplaint, generateDedupKey } from '../fblProcessor.js';
import { parseBounce } from '../parser.js';
import { extractReportParts } from '../reportParts.js';
import { logger } from '../../monitoring/logger.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const parseFblOrDsnPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'parse_fbl_or_dsn',
	async run(deps, ctx) {
		const { parsed, rcptTo, rawBuffer } = ctx;

		// Recover the non-body MIME parts (message/delivery-status, feedback-report,
		// message/rfc822, …) the scrapers read. `parseMessage` only surfaces
		// disposition/filename parts in `parsed.attachments`, but real DSNs/ARFs set
		// neither on their report parts — so they are walked out of the raw bytes
		// (behavior-preserving vs. mailparser's attachment surfacing).
		const reportParts = extractReportParts(rawBuffer);

		// 1. Try ARF/FBL (complaints) first — they're the highest-signal
		//    classification and have an authoritative duplicate-check.
		const arfResult = tryParseARF(parsed, reportParts);
		if (arfResult) {
			const dedupKey = generateDedupKey(parsed, arfResult.originalMessageId);
			const isDuplicate = await isDuplicateComplaint(deps.redis, dedupKey);
			if (isDuplicate) {
				logger.info(
					{ messageId: arfResult.originalMessageId, dedupKey },
					'Duplicate FBL complaint skipped'
				);
				return { kind: 'dropSilently', reason: 'duplicate_fbl_complaint' };
			}
			return { kind: 'bounceTo', attempt: { kind: 'fbl', arf: arfResult } };
		}

		// 2. Try DSN bounce.
		const bounceResult = parseBounce(parsed, reportParts, rcptTo);
		if (bounceResult && bounceResult.originalMessageId) {
			return {
				kind: 'bounceTo',
				attempt: { kind: 'dsn_attributed', bounce: bounceResult },
			};
		}
		if (bounceResult) {
			// DSN parsed but lacks an original Message-ID — record the metric
			// and accept (we can't attribute, but the recipient already paid
			// the bandwidth cost).
			return { kind: 'bounceTo', attempt: { kind: 'dsn_unattributed' } };
		}

		// `parseBounce` returns null both for "this isn't a bounce" AND for a
		// real bounce we couldn't attribute (no VERP token, no usable header).
		// A message addressed to our `bounce+…` VERP envelope IS such a bounce by
		// construction — `onRcptTo` only accepts that prefix for the bounce
		// processor. Classify it as `dsn_unattributed` so the unattributed-bounce
		// metric fires (RFC 3464: DSNs may lack a recoverable Message-ID; that
		// feedback must be observable, not silently routed to `unrecognized`).
		if (rcptTo?.startsWith('bounce+')) {
			return { kind: 'bounceTo', attempt: { kind: 'dsn_unattributed' } };
		}

		// 3. Not a complaint, not a bounce — defer routing to the next phase.
		return { kind: 'continue', ctx };
	},
};
