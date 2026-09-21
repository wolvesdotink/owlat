import { describe, expect, it } from 'vitest';
import { MAX_SCOPE_LENGTH, MAX_STATEMENT_LENGTH } from '../bodies.js';
import { validateAttestation } from '../validate.js';
import { attestationOf, bodyErrors } from './fixtures.js';

const REF = { logId: 'log.ostr.example', index: 3 };
const DECLARED_IPS_ERROR = 'body.declaredIps must be a non-empty array of distinct IP addresses';
describe('posture', () => {
	it('accepts a single declared fact', () => {
		const result = validateAttestation(attestationOf('posture', { body: { dnssec: true } }));
		expect(result.ok ? [] : result.errors).toEqual([]);
	});

	it('rejects a body that declares nothing', () => {
		const result = validateAttestation(attestationOf('posture', { body: {} }));
		expect(result.ok ? [] : result.errors).toContain('body must declare at least one posture fact');
	});

	it.each([
		['dmarcPolicy', 'p=reject', 'body.dmarcPolicy must be one of none, quarantine, reject'],
		['dmarcAlignment', 's', 'body.dmarcAlignment must be one of relaxed, strict'],
		['dnssec', 'yes', 'body.dnssec must be a boolean'],
		['mtaSts', 1, 'body.mtaSts must be a boolean'],
		['tlsRpt', null, 'body.tlsRpt must be a boolean'],
		['registeredBefore', '2019', 'body.registeredBefore must be an RFC 3339 timestamp'],
		['declaredIps', '192.0.2.7', DECLARED_IPS_ERROR],
		['declaredIps', ['192.0.2.999'], DECLARED_IPS_ERROR],
		['declaredIps', ['192.0.2.0/24'], DECLARED_IPS_ERROR],
		['declaredIps', [], DECLARED_IPS_ERROR],
		['declaredIps', ['192.0.2.7', '192.0.2.7'], DECLARED_IPS_ERROR],
	])('rejects %s = %p', (field, value, error) => {
		expect(bodyErrors('posture', { [field]: value })).toContain(error);
	});

	it('rejects a body whose only field is an empty declaredIps list', () => {
		// An empty list declares nothing, so it must not buy a log entry and a
		// scoring slot on its own.
		const errors = validateAttestation(attestationOf('posture', { body: { declaredIps: [] } }));
		expect(errors.ok ? [] : errors.errors).toEqual([
			'body must declare at least one posture fact',
			DECLARED_IPS_ERROR,
		]);
	});

	it('accepts a compromise disclosure', () => {
		expect(
			bodyErrors('posture', {
				compromiseDisclosure: {
					rotatedAt: '2026-08-10T09:00:00Z',
					affectedSelectors: ['mail2025', 'mail2026'],
				},
			})
		).toEqual([]);
	});

	it.each([
		[
			'a missing rotation time',
			{ affectedSelectors: ['mail2026'] },
			'body.compromiseDisclosure.rotatedAt must be an RFC 3339 timestamp',
		],
		[
			'an empty selector list',
			{ rotatedAt: '2026-08-10T09:00:00Z', affectedSelectors: [] },
			'body.compromiseDisclosure.affectedSelectors must be a non-empty array of DKIM selectors',
		],
		[
			'a selector list of non-selectors',
			{ rotatedAt: '2026-08-10T09:00:00Z', affectedSelectors: ['a b'] },
			'body.compromiseDisclosure.affectedSelectors must be a non-empty array of DKIM selectors',
		],
		[
			'an unknown field',
			{ rotatedAt: '2026-08-10T09:00:00Z', affectedSelectors: ['s'], note: 'x' },
			'body.compromiseDisclosure.note is not a defined field',
		],
	])('rejects a disclosure with %s', (_label, compromiseDisclosure, error) => {
		expect(bodyErrors('posture', { compromiseDisclosure })).toContain(error);
	});

	it('rejects a non-object disclosure', () => {
		expect(bodyErrors('posture', { compromiseDisclosure: 'we rotated' })).toContain(
			'body.compromiseDisclosure must be an object'
		);
	});
});

describe('vouch and vouch-revoke', () => {
	it.each([
		['empty', ''],
		['blank', '   '],
		['over the cap', 'x'.repeat(MAX_SCOPE_LENGTH + 1)],
		['a number', 1],
		['missing', undefined],
	])('rejects a %s scope', (_label, scope) => {
		expect(bodyErrors('vouch', { scope })).toContain(
			`body.scope must be non-blank text of at most ${MAX_SCOPE_LENGTH} characters`
		);
	});

	it('accepts a scope exactly at the cap', () => {
		expect(bodyErrors('vouch', { scope: 'x'.repeat(MAX_SCOPE_LENGTH) })).toEqual([]);
	});

	it('requires an expiry — an unbounded vouch is not a vouch', () => {
		expect(bodyErrors('vouch', { expires: undefined })).toContain(
			'body.expires must be an RFC 3339 timestamp'
		);
	});

	it.each([
		['missing', undefined, 'body.vouch must be a log entry reference'],
		['a number', 41, 'body.vouch must be a log entry reference'],
		[
			'missing its index',
			{ logId: 'log.example' },
			'body.vouch.index must be a non-negative integer',
		],
		[
			'negatively indexed',
			{ logId: 'log.example', index: -1 },
			'body.vouch.index must be a non-negative integer',
		],
		[
			'fractionally indexed',
			{ logId: 'log.example', index: 1.5 },
			'body.vouch.index must be a non-negative integer',
		],
		[
			'missing its log id',
			{ index: 1 },
			'body.vouch.logId must be a non-empty identifier without whitespace',
		],
		[
			'whitespaced',
			{ logId: 'log example', index: 1 },
			'body.vouch.logId must be a non-empty identifier without whitespace',
		],
		[
			'padded with fields',
			{ ...REF, url: 'https://log.example' },
			'body.vouch.url is not a defined field',
		],
	])('rejects a revocation whose reference is %s', (_label, vouch, error) => {
		expect(bodyErrors('vouch-revoke', { vouch })).toContain(error);
	});

	it('requires a reason for the revocation', () => {
		expect(bodyErrors('vouch-revoke', { reason: '' })).toContain(
			`body.reason must be non-blank text of at most ${MAX_STATEMENT_LENGTH} characters`
		);
	});
});

describe('appeal, response and retraction', () => {
	it('requires an appeal to contest at least one entry', () => {
		expect(bodyErrors('appeal', { contested: [] })).toContain(
			'body.contested must be a non-empty array of log entry references'
		);
		expect(bodyErrors('appeal', { contested: REF })).toContain(
			'body.contested must be a non-empty array of log entry references'
		);
	});

	it('reports the position of a malformed contested entry', () => {
		expect(bodyErrors('appeal', { contested: [REF, { logId: 'l.example' }] })).toContain(
			'body.contested[1].index must be a non-negative integer'
		);
	});

	it('caps the statement length', () => {
		expect(bodyErrors('appeal', { statement: 'x'.repeat(MAX_STATEMENT_LENGTH + 1) })).toContain(
			`body.statement must be non-blank text of at most ${MAX_STATEMENT_LENGTH} characters`
		);
	});

	it('rejects control characters in a statement', () => {
		expect(bodyErrors('appeal', { statement: `spoofed${String.fromCharCode(0)}` })).toContain(
			`body.statement must be non-blank text of at most ${MAX_STATEMENT_LENGTH} characters`
		);
	});

	it('allows newlines and tabs in a statement', () => {
		expect(bodyErrors('appeal', { statement: 'line one\n\tline two' })).toEqual([]);
	});

	it.each([
		['upheld', 'body.outcome must be substantiated or retracted'],
		['', 'body.outcome must be substantiated or retracted'],
		[undefined, 'body.outcome must be substantiated or retracted'],
	])('rejects the response outcome %p', (outcome, error) => {
		expect(bodyErrors('response', { outcome })).toContain(error);
	});

	it('accepts both defined outcomes', () => {
		expect(bodyErrors('response', { outcome: 'substantiated' })).toEqual([]);
		expect(bodyErrors('response', { outcome: 'retracted' })).toEqual([]);
	});

	it('requires a retraction to point at what it supersedes', () => {
		expect(bodyErrors('retraction', { supersedes: undefined })).toContain(
			'body.supersedes must be a log entry reference'
		);
	});
});

describe('audit-finding', () => {
	it.each([
		'equivocation',
		'invalid-attestation',
		'statistical-outlier',
		'unanswered-challenge',
		'duplicate-evidence',
	])('accepts the finding %s', (finding) => {
		expect(bodyErrors('audit-finding', { finding })).toEqual([]);
	});

	it.each([['misbehavior'], [''], [null]])('rejects the finding %p', (finding) => {
		expect(bodyErrors('audit-finding', { finding })).toContain(
			'body.finding must be one of equivocation, invalid-attestation, statistical-outlier, unanswered-challenge, duplicate-evidence'
		);
	});

	it('requires evidence — a finding without coordinates is an opinion', () => {
		expect(bodyErrors('audit-finding', { evidence: [] })).toContain(
			'body.evidence must be a non-empty array of log entry references'
		);
	});
});
