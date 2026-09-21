/**
 * Bodies that point at OTHER log entries: vouches and their revocations,
 * appeals, responses, retractions and audit findings (plan §5, §8).
 *
 * Every one of them cites log coordinates, and every citation list is required
 * to be non-empty: a dispute that names nothing is an opinion, and the registry
 * records claims that can be checked against the log.
 */
import type {
	AppealBody,
	AuditFindingBody,
	ResponseBody,
	RetractionBody,
	VouchBody,
	VouchRevokeBody,
} from '../types.js';
import {
	fieldsOf,
	MAX_SCOPE_LENGTH,
	MAX_STATEMENT_LENGTH,
	rejectUnknown,
	requireRfc3339,
	requireText,
	validateLogEntryRef,
	validateLogEntryRefList,
	type BodyValidator,
} from './bodyFields.js';

const VOUCH_FIELDS = fieldsOf<VouchBody>({ scope: true, expires: true });

export const validateVouch: BodyValidator = (body, errors) => {
	rejectUnknown(body, VOUCH_FIELDS, errors);
	requireText(body, 'scope', MAX_SCOPE_LENGTH, errors);
	requireRfc3339(body, 'expires', errors);
};

const VOUCH_REVOKE_FIELDS = fieldsOf<VouchRevokeBody>({ vouch: true, reason: true });

export const validateVouchRevoke: BodyValidator = (body, errors) => {
	rejectUnknown(body, VOUCH_REVOKE_FIELDS, errors);
	validateLogEntryRef(body['vouch'], 'body.vouch', errors);
	requireText(body, 'reason', MAX_STATEMENT_LENGTH, errors);
};

const APPEAL_FIELDS = fieldsOf<AppealBody>({ contested: true, statement: true });

export const validateAppeal: BodyValidator = (body, errors) => {
	rejectUnknown(body, APPEAL_FIELDS, errors);
	validateLogEntryRefList(body['contested'], 'body.contested', errors);
	requireText(body, 'statement', MAX_STATEMENT_LENGTH, errors);
};

const RESPONSE_FIELDS = fieldsOf<ResponseBody>({
	appeal: true,
	outcome: true,
	statement: true,
});

export const validateResponse: BodyValidator = (body, errors) => {
	rejectUnknown(body, RESPONSE_FIELDS, errors);
	validateLogEntryRef(body['appeal'], 'body.appeal', errors);
	const outcome = body['outcome'];
	if (outcome !== 'substantiated' && outcome !== 'retracted') {
		errors.push('body.outcome must be substantiated or retracted');
	}
	requireText(body, 'statement', MAX_STATEMENT_LENGTH, errors);
};

const RETRACTION_FIELDS = fieldsOf<RetractionBody>({ supersedes: true, reason: true });

export const validateRetraction: BodyValidator = (body, errors) => {
	rejectUnknown(body, RETRACTION_FIELDS, errors);
	validateLogEntryRef(body['supersedes'], 'body.supersedes', errors);
	requireText(body, 'reason', MAX_STATEMENT_LENGTH, errors);
};

const AUDIT_FINDING_FIELDS = fieldsOf<AuditFindingBody>({
	finding: true,
	evidence: true,
	statement: true,
});

const AUDIT_FINDINGS: readonly string[] = [
	'equivocation',
	'invalid-attestation',
	'statistical-outlier',
	'unanswered-challenge',
	'duplicate-evidence',
] as const satisfies readonly AuditFindingBody['finding'][];

export const validateAuditFinding: BodyValidator = (body, errors) => {
	rejectUnknown(body, AUDIT_FINDING_FIELDS, errors);
	const finding = body['finding'];
	if (typeof finding !== 'string' || !AUDIT_FINDINGS.includes(finding)) {
		errors.push(`body.finding must be one of ${AUDIT_FINDINGS.join(', ')}`);
	}
	validateLogEntryRefList(body['evidence'], 'body.evidence', errors);
	requireText(body, 'statement', MAX_STATEMENT_LENGTH, errors);
};
