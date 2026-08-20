import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '../../crypto.js';
import {
	formatOstrKeyRecord,
	ostrKeyRecordName,
	parseOstrKeyRecord,
	selectVerifyingKey,
} from '../keyRecord.js';
import { signAttestation } from '../sign.js';
import { FIXED_PRIVATE_KEY, FIXED_PUBLIC_KEY, GOLDEN_UNSIGNED } from './fixtures.js';

const keyOf = (txt: string): string | null => {
	const parsed = parseOstrKeyRecord(txt);
	return parsed.ok ? parsed.publicKeyBase64 : null;
};

const errorsOf = (txt: string): string[] => {
	const parsed = parseOstrKeyRecord(txt);
	return parsed.ok ? [] : parsed.errors;
};

describe('formatOstrKeyRecord', () => {
	it('renders the documented tag list', () => {
		expect(formatOstrKeyRecord(FIXED_PUBLIC_KEY)).toBe(`v=1; k=ed25519; p=${FIXED_PUBLIC_KEY}`);
	});

	it('round-trips any generated key', () => {
		for (let i = 0; i < 20; i++) {
			const { publicKey } = generateEd25519KeyPair();
			expect(keyOf(formatOstrKeyRecord(publicKey))).toBe(publicKey);
		}
	});

	it.each([
		['empty', ''],
		['31 bytes', Buffer.alloc(31).toString('base64')],
		['33 bytes', Buffer.alloc(33).toString('base64')],
		['hex', 'a'.repeat(64)],
		['whitespaced', `${FIXED_PUBLIC_KEY.slice(0, 10)} ${FIXED_PUBLIC_KEY.slice(10)}`],
		['base64url', Buffer.alloc(32, 251).toString('base64url')],
	])('refuses to publish a %s key', (_label, publicKeyBase64) => {
		expect(() => formatOstrKeyRecord(publicKeyBase64)).toThrow(/32-byte ed25519/);
	});

	it('names the record under the _ostr prefix', () => {
		expect(ostrKeyRecordName('mx.hinterland.camp')).toBe('_ostr.mx.hinterland.camp');
	});

	it.each([
		['uppercase', 'Example.com'],
		['a trailing dot', 'example.com.'],
		['a single label', 'localhost'],
		['an empty string', ''],
		['an IP address', '192.0.2.7'],
	])('refuses to name a record for a %s owner', (_label, domain) => {
		// A name no observer field would ever match is a lookup that silently
		// finds nothing, not a usable owner name.
		expect(() => ostrKeyRecordName(domain)).toThrow(/lowercase FQDN/);
	});
});

describe('parseOstrKeyRecord tolerance', () => {
	it.each([
		['the canonical form', `v=1; k=ed25519; p=${FIXED_PUBLIC_KEY}`],
		['no spaces', `v=1;k=ed25519;p=${FIXED_PUBLIC_KEY}`],
		['generous spacing', `  v = 1 ;   k = ed25519 ;  p = ${FIXED_PUBLIC_KEY}  `],
		['reordered tags', `p=${FIXED_PUBLIC_KEY}; k=ed25519; v=1`],
		['a trailing semicolon', `v=1; k=ed25519; p=${FIXED_PUBLIC_KEY};`],
		['empty segments', `v=1;; k=ed25519; ; p=${FIXED_PUBLIC_KEY}`],
		['tabs and newlines', `v=1;\tk=ed25519;\np=${FIXED_PUBLIC_KEY}`],
		['an uppercase tag name', `V=1; K=ed25519; P=${FIXED_PUBLIC_KEY}`],
		['an uppercase key type', `v=1; k=Ed25519; p=${FIXED_PUBLIC_KEY}`],
		['no k tag (ed25519 is the v1 default)', `v=1; p=${FIXED_PUBLIC_KEY}`],
		['an unknown tag', `v=1; k=ed25519; n=rotating soon; p=${FIXED_PUBLIC_KEY}`],
		[
			'a key split by a provisioning tool',
			`v=1; k=ed25519; p=${FIXED_PUBLIC_KEY.slice(0, 20)} ${FIXED_PUBLIC_KEY.slice(20)}`,
		],
	])('accepts %s', (_label, txt) => {
		expect(keyOf(txt)).toBe(FIXED_PUBLIC_KEY);
	});
});

describe('parseOstrKeyRecord rejection', () => {
	it.each([
		['empty', '', 'record must be a non-empty string'],
		['blank', '   ', 'record must be a non-empty string'],
		['a non-string', 42 as unknown as string, 'record must be a non-empty string'],
		['missing the version', `k=ed25519; p=${FIXED_PUBLIC_KEY}`, 'missing v tag'],
		['a future version', `v=2; p=${FIXED_PUBLIC_KEY}`, 'unsupported record version "2"'],
		['a DKIM version', `v=DKIM1; p=${FIXED_PUBLIC_KEY}`, 'unsupported record version "DKIM1"'],
		['an RSA key', `v=1; k=rsa; p=${FIXED_PUBLIC_KEY}`, 'unsupported key type "rsa"'],
		['missing the key', 'v=1; k=ed25519', 'missing p tag'],
		['a revoked key', 'v=1; k=ed25519; p=', 'p tag is empty (revoked key)'],
		[
			'a truncated key',
			`v=1; p=${Buffer.alloc(31).toString('base64')}`,
			'p tag must be a raw 32-byte ed25519 public key in base64',
		],
		[
			'a hex key',
			`v=1; p=${'a'.repeat(64)}`,
			'p tag must be a raw 32-byte ed25519 public key in base64',
		],
		[
			'a base64url key',
			`v=1; p=${Buffer.alloc(32, 251).toString('base64url')}`,
			'p tag must be a raw 32-byte ed25519 public key in base64',
		],
		[
			'a duplicated tag',
			`v=1; p=${FIXED_PUBLIC_KEY}; p=${FIXED_PUBLIC_KEY}`,
			'tag p appears more than once',
		],
		[
			'a valueless segment',
			`v=1; revoked; p=${FIXED_PUBLIC_KEY}`,
			'"revoked" is not a tag=value pair',
		],
		['a numeric tag name', `v=1; 1=x; p=${FIXED_PUBLIC_KEY}`, '"1" is not a valid tag name'],
	])('rejects a record that is %s', (_label, txt, error) => {
		expect(errorsOf(txt)).toContain(error);
	});

	it('rejects an oversized record without parsing it', () => {
		expect(errorsOf(`v=1; k=ed25519; p=${'A'.repeat(4000)}`)).toEqual([
			'record must be at most 2048 characters',
		]);
	});

	it('reports every problem in one pass', () => {
		expect(errorsOf('v=9; k=rsa; p=nope')).toEqual([
			'unsupported record version "9"',
			'unsupported key type "rsa"',
			'p tag must be a raw 32-byte ed25519 public key in base64',
		]);
	});

	it('never returns a key alongside an error', () => {
		const parsed = parseOstrKeyRecord(`v=2; p=${FIXED_PUBLIC_KEY}`);
		expect(parsed.ok).toBe(false);
		expect(parsed).not.toHaveProperty('publicKeyBase64');
	});

	it('reports a withdrawn key as revoked, not merely unparsable', () => {
		// "Stop trusting this key" and "this record is corrupt, try the siblings"
		// are different answers; a caller must not have to match error strings.
		const parsed = parseOstrKeyRecord('v=1; k=ed25519; p=');
		expect(parsed.ok).toBe(false);
		expect(parsed.ok || parsed.revoked).toBe(true);
	});

	it.each([
		['a corrupt key', `v=1; p=${Buffer.alloc(31).toString('base64')}`],
		['a missing p tag', 'v=1; k=ed25519'],
		['an unsupported version', `v=2; p=${FIXED_PUBLIC_KEY}`],
		['garbage', 'nonsense'],
	])('does not call %s revoked', (_label, txt) => {
		const parsed = parseOstrKeyRecord(txt);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok || parsed.revoked).toBe(false);
	});

	it('rejects a non-canonically spelled key rather than re-encoding it', () => {
		// Same 32 bytes, non-zero bits past the declared length — `Buffer.from`
		// decodes it happily, so one key would have two published spellings.
		const nonCanonical = '7LA40H1E04PS9o11qI3oTmc6dzB0cVVW9n8PgUpa7/d=';
		expect(Buffer.from(nonCanonical, 'base64').toString('base64')).toBe(FIXED_PUBLIC_KEY);
		expect(errorsOf(`v=1; p=${nonCanonical}`)).toContain(
			'p tag must be a raw 32-byte ed25519 public key in base64'
		);
	});
});

describe('selectVerifyingKey', () => {
	const attestation = signAttestation(GOLDEN_UNSIGNED, FIXED_PRIVATE_KEY);
	const record = formatOstrKeyRecord(FIXED_PUBLIC_KEY);
	const strangerRecord = formatOstrKeyRecord(generateEd25519KeyPair().publicKey);

	it('finds the only published key', () => {
		expect(selectVerifyingKey([record], attestation)).toBe(FIXED_PUBLIC_KEY);
	});

	it('finds the signing key among rotation siblings, in any position', () => {
		expect(selectVerifyingKey([strangerRecord, record], attestation)).toBe(FIXED_PUBLIC_KEY);
		expect(selectVerifyingKey([record, strangerRecord], attestation)).toBe(FIXED_PUBLIC_KEY);
	});

	it('steps over unparsable siblings rather than giving up on the name', () => {
		expect(selectVerifyingKey(['v=1; k=rsa; p=zzz', 'garbage', record], attestation)).toBe(
			FIXED_PUBLIC_KEY
		);
	});

	it('returns null when no published key signed the attestation', () => {
		expect(selectVerifyingKey([strangerRecord], attestation)).toBeNull();
		expect(selectVerifyingKey([], attestation)).toBeNull();
		expect(selectVerifyingKey(['nonsense'], attestation)).toBeNull();
	});

	it('returns null for a tampered attestation even with the right key published', () => {
		const tampered = { ...attestation, observer: 'mx.evil.example' };
		expect(selectVerifyingKey([record], tampered)).toBeNull();
	});

	it('is deterministic for a deterministic record list', () => {
		const records = [strangerRecord, record, record];
		expect(selectVerifyingKey(records, attestation)).toBe(selectVerifyingKey(records, attestation));
	});
});
