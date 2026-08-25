import { describe, expect, it } from 'vitest';
import {
	MAX_BOUNCE_RATE_BUCKET,
	MAX_UNIQUE_RECIPIENTS_BUCKET,
	normalizeObservedKey,
} from '../bodies.js';
import { bodyErrors } from './fixtures.js';

const NOT_A_COUNT = [-1, 1.5, '3', null, undefined, Number.NaN, Number.MAX_SAFE_INTEGER + 2];
describe('traffic-summary', () => {
	it.each([
		'messages',
		'spfPass',
		'dkimPass',
		'dmarcPass',
		'tlsInbound',
		'uniqueRecipientsBucket',
		'bounceRateBucket',
	])('requires %s to be a non-negative integer', (field) => {
		for (const value of NOT_A_COUNT) {
			expect(bodyErrors('traffic-summary', { [field]: value })).toContain(
				`body.${field} must be a non-negative integer`
			);
		}
	});

	it.each(['spfPass', 'dkimPass', 'dmarcPass', 'tlsInbound'])(
		'rejects %s exceeding the message count it is a subset of',
		(field) => {
			expect(bodyErrors('traffic-summary', { messages: 10, [field]: 11 })).toContain(
				`body.${field} must not exceed body.messages`
			);
		}
	);

	it('accepts an all-zero window — a silent day is still evidence', () => {
		expect(
			bodyErrors('traffic-summary', {
				messages: 0,
				spfPass: 0,
				dkimPass: 0,
				dmarcPass: 0,
				tlsInbound: 0,
				uniqueRecipientsBucket: 0,
				bounceRateBucket: 0,
			})
		).toEqual([]);
	});

	it('rejects fields this kind does not define', () => {
		expect(bodyErrors('traffic-summary', { spamPass: 4 })).toContain(
			'body.spamPass is not a field of this attestation kind'
		);
	});

	it.each([
		['uniqueRecipientsBucket', MAX_UNIQUE_RECIPIENTS_BUCKET],
		['bounceRateBucket', MAX_BOUNCE_RATE_BUCKET],
	])('accepts %s exactly at its cap', (field, cap) => {
		expect(bodyErrors('traffic-summary', { [field]: cap })).toEqual([]);
	});

	it.each([
		['uniqueRecipientsBucket', MAX_UNIQUE_RECIPIENTS_BUCKET],
		['bounceRateBucket', MAX_BOUNCE_RATE_BUCKET],
	])('rejects %s past its cap — a bucket is an exponent, not a count', (field, cap) => {
		for (const value of [cap + 1, 999999, Number.MAX_SAFE_INTEGER]) {
			expect(bodyErrors('traffic-summary', { [field]: value })).toContain(
				`body.${field} must be at most ${cap}`
			);
		}
	});
});

describe('spam-report-batch', () => {
	it('requires a report count', () => {
		expect(bodyErrors('spam-report-batch', { reports: -2 })).toContain(
			'body.reports must be a non-negative integer'
		);
	});

	it.each([
		['uppercase hex', 'A'.repeat(64)],
		['63 hex characters', 'a'.repeat(63)],
		['a base64 digest', Buffer.alloc(32).toString('base64')],
		['prefixed', `sha256:${'a'.repeat(64)}`],
		['missing', undefined],
		['a number', 1],
	])('rejects a commitment that is %s', (_label, commitment) => {
		expect(bodyErrors('spam-report-batch', { commitment })).toContain(
			'body.commitment must be a lowercase hex sha256 Merkle root'
		);
	});
});

describe('trap-hit', () => {
	it('requires a hit count and nothing else', () => {
		expect(bodyErrors('trap-hit', { hits: undefined })).toContain(
			'body.hits must be a non-negative integer'
		);
		expect(bodyErrors('trap-hit', { addresses: ['trap@example.com'] })).toContain(
			'body.addresses is not a field of this attestation kind'
		);
	});
});

/** An ed25519 SubjectPublicKeyInfo: 44 bytes, `30 2a` header + 32 key bytes. */
const ED25519_SPKI = 'MCowBQYDK2VwAyEABwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
/** A real 2048-bit RSA SubjectPublicKeyInfo: 294 bytes, long-form length header.
 *  Real DKIM keys are overwhelmingly RSA, so this is the shape that matters. */
const RSA_2048_SPKI =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1fevLmxtIkjvCLSTb9WecNg8Eou4Bqzh63fr34ed3y/N' +
	'udHizsAENs1Byr1CTV5S0ICgERLZndbTP8cnKwg6eYoC/E3k+mcTIlLm/gUKVXfyX7y0y17djyqLO/YHgvijfab9' +
	'CqIi6ONQCMkjkdLqpELwP1PK+SrT16pQb9ngfq43u866ZzZlBshcaoilBjEruQCdBY78SBCnspfJD5S4X0QXsNdL' +
	'8iWMMrAjgUMKUzCj1aFg9tQxfrViYPea6w2LSr/tptYQISHV1g1ZwSiP1wd1uydxF7/WKLj/IjF1bvCRLXTfJ2tV' +
	'XVOz+LtTzNOuA/CwoWTxNMegVtHNj1Uy7wIDAQAB';

/** 0x30-tagged, long enough, but the length header accounts for other bytes
 *  than the ones present — it will not parse at challenge time (plan §7.5). */
function misframedSpki(declaredLength: number, actualLength: number): string {
	const der = Buffer.alloc(actualLength, 7);
	der[0] = 0x30;
	der[1] = declaredLength;
	return der.toString('base64');
}

describe('key-observation', () => {
	it.each([
		['an ed25519 SPKI', ED25519_SPKI],
		['a 2048-bit RSA SPKI', RSA_2048_SPKI],
	])('accepts %s as well as the digest form', (_label, publicKey) => {
		expect(bodyErrors('key-observation', { publicKey })).toEqual([]);
	});

	it.each([
		['whitespaced base64', 'AAAA AAAA'],
		['a bare hex digest', 'b'.repeat(64)],
		['base64 without the DER SEQUENCE tag', Buffer.alloc(44, 3).toString('base64')],
		['a DER-tagged value too short to be a key', Buffer.from([0x30, 0x03]).toString('base64')],
		['a DER-tagged blob whose length header reads zero', misframedSpki(0, 44)],
		['a SEQUENCE claiming fewer bytes than it carries', misframedSpki(0x20, 60)],
		['a SEQUENCE claiming more bytes than it carries', misframedSpki(0x7e, 60)],
		['a truncated digest', `sha256:${'b'.repeat(63)}`],
		['an uppercase digest', `sha256:${'B'.repeat(64)}`],
		['empty', ''],
		['a number', 7],
	])('rejects a publicKey that is %s', (_label, publicKey) => {
		expect(bodyErrors('key-observation', { publicKey })).toContain(
			'body.publicKey must be base64 SPKI DER or "sha256:<hex>"'
		);
	});

	it('normalizes both accepted spellings to one comparable digest (plan §7.5)', () => {
		const digest = normalizeObservedKey(ED25519_SPKI);
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		// A second observer that logged the digest instead agrees by equality.
		expect(normalizeObservedKey(digest)).toBe(digest);
		expect(normalizeObservedKey(RSA_2048_SPKI)).not.toBe(digest);
	});

	it('normalizes nothing it would reject', () => {
		for (const value of ['', 'b'.repeat(64), `sha256:${'B'.repeat(64)}`, 7, null]) {
			expect(normalizeObservedKey(value)).toBeNull();
		}
	});

	it.each([
		['uppercase', 'Example.com'],
		['a single label', 'localhost'],
		['missing', undefined],
	])('rejects a %s domain', (_label, domain) => {
		expect(bodyErrors('key-observation', { domain })).toContain(
			'body.domain must be a lowercase FQDN'
		);
	});

	it.each([
		['empty', ''],
		['dot-leading', '.mail'],
		['spaced', 'mail 2026'],
		['a number', 2026],
	])('rejects a %s selector', (_label, selector) => {
		expect(bodyErrors('key-observation', { selector })).toContain(
			'body.selector must be a DKIM selector'
		);
	});

	it('rejects a last-seen before the first-seen', () => {
		expect(
			bodyErrors('key-observation', {
				firstSeen: '2026-08-19T00:00:00Z',
				lastSeen: '2026-08-18T00:00:00Z',
			})
		).toContain('body.firstSeen must not be after body.lastSeen');
	});

	it('requires dnssecValidated to be a boolean, not a truthy string', () => {
		expect(bodyErrors('key-observation', { dnssecValidated: 'true' })).toContain(
			'body.dnssecValidated must be a boolean'
		);
	});
});
