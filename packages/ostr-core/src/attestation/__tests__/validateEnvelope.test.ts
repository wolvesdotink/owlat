import { describe, expect, it } from 'vitest';
import {
	ATTESTATION_KINDS,
	isAttestationKind,
	validateAttestation,
	WINDOW_REQUIRED_KINDS,
} from '../validate.js';
import { attestationOf, GOLDEN_SIGNATURE, WINDOWED_KINDS } from './fixtures.js';

const errorsOf = (value: unknown): string[] => {
	const result = validateAttestation(value);
	return result.ok ? [] : result.errors;
};

const window = { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' };

describe('the kind vocabulary', () => {
	it('covers exactly the eleven kinds of plan §5', () => {
		expect(ATTESTATION_KINDS).toHaveLength(11);
		expect([...ATTESTATION_KINDS]).toEqual([...ATTESTATION_KINDS].sort());
	});

	it.each([...ATTESTATION_KINDS])('accepts a well-formed %s attestation', (kind) => {
		const result = validateAttestation(attestationOf(kind));
		expect(result.ok ? [] : result.errors).toEqual([]);
	});

	it('returns the validated document itself, not a copy', () => {
		const input = attestationOf('trap-hit');
		const result = validateAttestation(input);
		expect(result.ok && result.attestation).toBe(input);
	});

	it.each([
		['unknown', 'traffic-summaries'],
		['empty', ''],
		['differently cased', 'Trap-Hit'],
		['non-string', 7],
		['missing', undefined],
	])('rejects a %s kind', (_label, kind) => {
		expect(errorsOf(attestationOf('trap-hit', { kind }))).toContain(
			'kind must be a known attestation kind'
		);
	});

	it('answers isAttestationKind for hostile values without throwing', () => {
		expect(isAttestationKind('vouch')).toBe(true);
		expect(isAttestationKind('toString')).toBe(false);
		expect(isAttestationKind(null)).toBe(false);
	});
});

describe('envelope shape', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['a string', '{"v":1}'],
		['a number', 1],
		['an array', [{ v: 1 }]],
	])('rejects %s outright', (_label, value) => {
		expect(errorsOf(value)).toEqual(['attestation must be a JSON object']);
	});

	it.each([
		['0', 0],
		['2', 2],
		['the string "1"', '1'],
		['missing', undefined],
	])('rejects version %s', (_label, v) => {
		expect(errorsOf(attestationOf('trap-hit', { v }))).toContain('v must be 1');
	});

	it('rejects unknown envelope fields — a signed log entry carries no payload', () => {
		expect(errorsOf(attestationOf('trap-hit', { extra: 'x', proof: 1 }))).toEqual([
			'extra is not a field of a v1 attestation',
			'proof is not a field of a v1 attestation',
		]);
	});

	it('rejects a top-level __proto__ member like any other unknown field', () => {
		// Only JSON.parse or defineProperty give an OWN `__proto__` property; an
		// object literal hits the inherited setter and never reaches the validator.
		const doc = attestationOf('trap-hit');
		Object.defineProperty(doc, '__proto__', {
			value: { evil: 1 },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		expect(errorsOf(doc)).toContain('__proto__ is not a field of a v1 attestation');
	});

	it('reports every problem at once', () => {
		expect(
			errorsOf({ v: 2, kind: 'nope', observer: 'X', subject: {}, body: 1, sig: 'x' }).length
		).toBeGreaterThanOrEqual(6);
	});

	it('rejects a missing or non-object body', () => {
		for (const body of [undefined, null, 'x', 7, []]) {
			expect(errorsOf(attestationOf('trap-hit', { body }))).toContain('body must be an object');
		}
	});
});

describe('observer identity', () => {
	it.each([
		['a subdomain', 'mx.hinterland.camp'],
		['a two-label domain', 'example.com'],
		['a hyphenated label', 'mx-1.example.com'],
		['a digit label', '4.example.com'],
	])('accepts %s', (_label, observer) => {
		expect(errorsOf(attestationOf('trap-hit', { observer }))).toEqual([]);
	});

	it.each([
		['uppercase', 'MX.Example.com'],
		['a single label', 'localhost'],
		['a trailing dot', 'example.com.'],
		['an empty string', ''],
		['a leading dot', '.example.com'],
		['a double dot', 'a..example.com'],
		['an underscore', '_ostr.example.com'],
		['a numeric TLD (an IP)', '192.0.2.7'],
		['a space', 'mx example.com'],
		['a label over 63 characters', `${'a'.repeat(64)}.com`],
		['a name over 253 characters', `${'a.'.repeat(130)}com`],
		['a non-string', 42],
		['missing', undefined],
	])('rejects %s', (_label, observer) => {
		expect(errorsOf(attestationOf('trap-hit', { observer }))).toContain(
			'observer must be a lowercase FQDN'
		);
	});
});

describe('subject', () => {
	it.each([
		['a domain', { domain: 'example.com' }],
		['an IPv4 address', { ip: '192.0.2.7' }],
		['an IPv6 address', { ip: '2001:db8::1' }],
		['a compressed IPv6 address', { ip: '::1' }],
		['an IPv4-mapped IPv6 address', { ip: '::ffff:192.0.2.7' }],
		['both a domain and an IP', { domain: 'example.com', ip: '192.0.2.7' }],
	])('accepts %s', (_label, subject) => {
		expect(errorsOf(attestationOf('trap-hit', { subject }))).toEqual([]);
	});

	it.each([
		['empty', {}, 'subject must carry a domain, an ip, or both'],
		['missing', undefined, 'subject must be an object with a domain, an ip, or both'],
		['null', null, 'subject must be an object with a domain, an ip, or both'],
		['an array', [], 'subject must be an object with a domain, an ip, or both'],
		['an uppercase domain', { domain: 'Example.com' }, 'subject.domain must be a lowercase FQDN'],
		[
			'an IP in the domain field',
			{ domain: '192.0.2.7' },
			'subject.domain must be a lowercase FQDN',
		],
		[
			'an octal-looking IPv4',
			{ ip: '010.0.0.1' },
			'subject.ip must be an IPv4 or canonical IPv6 address',
		],
		[
			'an out-of-range IPv4',
			{ ip: '192.0.2.256' },
			'subject.ip must be an IPv4 or canonical IPv6 address',
		],
		[
			'an uppercase IPv6',
			{ ip: '2001:DB8::1' },
			'subject.ip must be an IPv4 or canonical IPv6 address',
		],
		[
			'an IPv6 with two compressions',
			{ ip: '2001::db8::1' },
			'subject.ip must be an IPv4 or canonical IPv6 address',
		],
		[
			'a CIDR range',
			{ ip: '192.0.2.0/24' },
			'subject.ip must be an IPv4 or canonical IPv6 address',
		],
		[
			'an unknown field',
			{ domain: 'example.com', asn: 64500 },
			'subject.asn is not a defined field',
		],
	])('rejects %s', (_label, subject, error) => {
		expect(errorsOf(attestationOf('trap-hit', { subject }))).toContain(error);
	});
});

describe('window', () => {
	it('publishes the same windowed-kind list the fixtures build against', () => {
		expect([...WINDOW_REQUIRED_KINDS]).toEqual(WINDOWED_KINDS);
	});

	it.each([...WINDOWED_KINDS])('requires a window for %s', (kind) => {
		const doc = attestationOf(kind);
		delete doc['window'];
		expect(errorsOf(doc)).toContain(`window is required for kind ${kind}`);
	});

	it.each(ATTESTATION_KINDS.filter((kind) => !WINDOWED_KINDS.includes(kind)))(
		'leaves the window optional for %s',
		(kind) => {
			expect(errorsOf(attestationOf(kind))).toEqual([]);
			expect(errorsOf(attestationOf(kind, { window }))).toEqual([]);
		}
	);

	it.each([
		[
			'from after to',
			{ from: '2026-08-20T00:00:00Z', to: '2026-08-19T00:00:00Z' },
			'window.from must not be after window.to',
		],
		[
			'a date without a time',
			{ from: '2026-08-19', to: '2026-08-20' },
			'window.from must be an RFC 3339 timestamp',
		],
		[
			'a timestamp without an offset',
			{ from: '2026-08-19T00:00:00', to: '2026-08-20T00:00:00Z' },
			'window.from must be an RFC 3339 timestamp',
		],
		[
			'an impossible day',
			{ from: '2026-02-30T00:00:00Z', to: '2026-08-20T00:00:00Z' },
			'window.from must be an RFC 3339 timestamp',
		],
		[
			'epoch millis',
			{ from: 1755561600000, to: 1755648000000 },
			'window.from must be an RFC 3339 timestamp',
		],
		[
			'a missing bound',
			{ from: '2026-08-19T00:00:00Z' },
			'window.to must be an RFC 3339 timestamp',
		],
		['an unknown field', { ...window, tz: 'UTC' }, 'window.tz is not a defined field'],
		[
			'a numeric offset instead of Z',
			{ from: '2026-08-19T02:00:00+02:00', to: '2026-08-20T00:00:00Z' },
			'window.from must be an RFC 3339 timestamp',
		],
		[
			'lowercase designators',
			{ from: '2026-08-19t00:00:00z', to: '2026-08-20T00:00:00Z' },
			'window.from must be an RFC 3339 timestamp',
		],
	])('rejects a window with %s', (_label, value, error) => {
		expect(errorsOf(attestationOf('trap-hit', { window: value }))).toContain(error);
	});

	it('rejects a non-object window', () => {
		expect(errorsOf(attestationOf('trap-hit', { window: '2026-08-19/2026-08-20' }))).toContain(
			'window must be an object with from and to'
		);
	});

	it('accepts equal bounds — a zero-length window is a claim about no time', () => {
		expect(
			errorsOf(
				attestationOf('trap-hit', {
					window: { from: '2026-08-19T00:00:00Z', to: '2026-08-19T00:00:00Z' },
				})
			)
		).toEqual([]);
	});

	it('accepts millisecond precision on either bound', () => {
		expect(
			errorsOf(
				attestationOf('trap-hit', {
					window: { from: '2026-08-19T00:00:00.250Z', to: '2026-08-20T00:00:00Z' },
				})
			)
		).toEqual([]);
	});
});

describe('signature shape', () => {
	it.each([
		['missing', undefined],
		['empty', ''],
		['unprefixed', GOLDEN_SIGNATURE.slice('ed25519:'.length)],
		['prefixed with another algorithm', GOLDEN_SIGNATURE.replace('ed25519:', 'rsa:')],
		['a non-string', 1],
	])('rejects a %s sig', (_label, sig) => {
		expect(errorsOf(attestationOf('trap-hit', { sig }))).toContain(
			'sig must be "ed25519:<base64>"'
		);
	});

	it.each([
		['too short', `ed25519:${Buffer.alloc(63).toString('base64')}`],
		['too long', `ed25519:${Buffer.alloc(65).toString('base64')}`],
		['not base64', 'ed25519:!!!!'],
		['base64url', `ed25519:${Buffer.alloc(64).toString('base64url')}`],
		['whitespaced', `ed25519:${Buffer.alloc(64).toString('base64').replace('A', ' ')}`],
	])('rejects a sig that is %s', (_label, sig) => {
		expect(errorsOf(attestationOf('trap-hit', { sig }))).toContain(
			'sig must carry a base64 64-byte ed25519 signature'
		);
	});

	it('does not verify the signature — that is verifyAttestationSignature', () => {
		const forged = attestationOf('trap-hit', {
			sig: `ed25519:${Buffer.alloc(64, 9).toString('base64')}`,
		});
		expect(validateAttestation(forged).ok).toBe(true);
	});
});
