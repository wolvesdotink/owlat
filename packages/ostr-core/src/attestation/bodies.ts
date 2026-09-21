/**
 * Per-kind body validation (plan §5). One validator per {@link AttestationKind},
 * collected in {@link BODY_VALIDATORS} as a total record so a kind added to the
 * vocabulary fails to compile until its body rules exist.
 *
 * Validators are pure and I/O-free: they check shape and internal consistency
 * (a pass count cannot exceed the message count, a window cannot end before it
 * starts). Whether a claim is TRUE is never decided here — that is what the
 * log, the challenge protocol and the scoring policy are for.
 *
 * The rules themselves live next to the party that authors them: what an
 * observer says about someone else, what a subject declares about itself, and
 * what either says about entries already in the log.
 */
import type { AttestationKind } from '../types.js';
import {
	validateAppeal,
	validateAuditFinding,
	validateResponse,
	validateRetraction,
	validateVouch,
	validateVouchRevoke,
} from './disputeBodies.js';
import {
	validateKeyObservation,
	validateSpamReportBatch,
	validateTrafficSummary,
	validateTrapHit,
} from './observerBodies.js';
import { validatePosture } from './subjectBodies.js';
import type { BodyValidator } from './bodyFields.js';

export { MAX_SCOPE_LENGTH, MAX_STATEMENT_LENGTH, type BodyValidator } from './bodyFields.js';
export {
	MAX_BOUNCE_RATE_BUCKET,
	MAX_UNIQUE_RECIPIENTS_BUCKET,
	normalizeObservedKey,
} from './observerBodies.js';

/** Total over {@link AttestationKind}: a new kind is a compile error here. */
export const BODY_VALIDATORS: Record<AttestationKind, BodyValidator> = {
	'traffic-summary': validateTrafficSummary,
	'spam-report-batch': validateSpamReportBatch,
	'trap-hit': validateTrapHit,
	'key-observation': validateKeyObservation,
	posture: validatePosture,
	vouch: validateVouch,
	'vouch-revoke': validateVouchRevoke,
	appeal: validateAppeal,
	response: validateResponse,
	retraction: validateRetraction,
	'audit-finding': validateAuditFinding,
};
