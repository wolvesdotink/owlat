import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../jcs.js';
import { generateEd25519KeyPair } from '../../crypto.js';
import type { Attestation } from '../../types.js';
import {
	ATTESTATION_SIGNATURE_PREFIX,
	attestationSigningView,
	isAttestationSignature,
	signAttestation,
	verifyAttestationSignature,
} from '../sign.js';
import {
	FIXED_PRIVATE_KEY,
	FIXED_PUBLIC_KEY,
	GOLDEN_CANONICAL,
	GOLDEN_SIGNATURE,
	GOLDEN_UNSIGNED,
} from './fixtures.js';

const signed = () => signAttestation(GOLDEN_UNSIGNED, FIXED_PRIVATE_KEY);

/** Re-signing a mutated document proves the field is inside the signature;
 *  verifying the ORIGINAL signature against it proves detection. */
function tampered(mutate: (doc: Record<string, unknown>) => void): Attestation {
	const doc = JSON.parse(JSON.stringify(signed())) as Record<string, unknown>;
	mutate(doc);
	return doc as unknown as Attestation;
}

describe('determinism pin', () => {
	it('signs the hand-written canonical form of the fixture', () => {
		expect(canonicalize(attestationSigningView(GOLDEN_UNSIGNED))).toBe(GOLDEN_CANONICAL);
	});

	it('produces the pinned signature — a change here changes every published sig', () => {
		expect(signed().sig).toBe(GOLDEN_SIGNATURE);
	});

	it('is insensitive to member order in the input object', () => {
		const reordered = {
			body: GOLDEN_UNSIGNED.body,
			window: GOLDEN_UNSIGNED.window,
			subject: GOLDEN_UNSIGNED.subject,
			observer: GOLDEN_UNSIGNED.observer,
			kind: GOLDEN_UNSIGNED.kind,
			v: GOLDEN_UNSIGNED.v,
		} as typeof GOLDEN_UNSIGNED;
		expect(signAttestation(reordered, FIXED_PRIVATE_KEY).sig).toBe(GOLDEN_SIGNATURE);
	});
});

describe('signAttestation', () => {
	it('round-trips with the matching public key', () => {
		expect(verifyAttestationSignature(signed(), FIXED_PUBLIC_KEY)).toBe(true);
	});

	it('prefixes the signature with its algorithm', () => {
		expect(signed().sig.startsWith(ATTESTATION_SIGNATURE_PREFIX)).toBe(true);
	});

	it('leaves the document otherwise untouched', () => {
		const attestation = signed();
		expect(attestationSigningView(attestation)).toEqual(GOLDEN_UNSIGNED);
	});

	it('replaces a signature already present rather than signing over it', () => {
		const resigned = signAttestation(
			{ ...GOLDEN_UNSIGNED, sig: 'ed25519:stale' } as typeof GOLDEN_UNSIGNED,
			FIXED_PRIVATE_KEY
		);
		expect(resigned.sig).toBe(GOLDEN_SIGNATURE);
	});

	it('covers extension fields the envelope does not define', () => {
		const extended = { ...GOLDEN_UNSIGNED, ext: 'future' } as typeof GOLDEN_UNSIGNED;
		const attestation = signAttestation(extended, FIXED_PRIVATE_KEY);
		expect(attestation.sig).not.toBe(GOLDEN_SIGNATURE);
		expect(verifyAttestationSignature(attestation, FIXED_PUBLIC_KEY)).toBe(true);
		const stripped = { ...attestation } as Record<string, unknown>;
		delete stripped['ext'];
		expect(verifyAttestationSignature(stripped as unknown as Attestation, FIXED_PUBLIC_KEY)).toBe(
			false
		);
	});

	it('adds nothing to the signed bytes but takes nothing out either', () => {
		const view = attestationSigningView(signed());
		expect(Object.keys(view).sort()).toEqual([
			'body',
			'kind',
			'observer',
			'subject',
			'v',
			'window',
		]);
	});

	it('covers a field added to the envelope after signing', () => {
		const extended = { ...signed(), ext: 'future' } as unknown as Attestation;
		expect(verifyAttestationSignature(extended, FIXED_PUBLIC_KEY)).toBe(false);
	});

	it('throws on a key that is not 32 raw bytes', () => {
		expect(() => signAttestation(GOLDEN_UNSIGNED, 'nope')).toThrow(/32 raw bytes/);
	});
});

/**
 * `__proto__` is the one member name an object-literal write cannot store: the
 * inherited setter swallows it. A signing view built that way would leave it
 * OUT of the signed bytes, making it an unsigned envelope field an attacker
 * could add, change or strip at will.
 */
describe('a top-level __proto__ member', () => {
	/** An own, enumerable `__proto__` — the only way JSON gives one. */
	function withOwnProto(doc: Record<string, unknown>, value: unknown): Record<string, unknown> {
		Object.defineProperty(doc, '__proto__', {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
		return doc;
	}

	const hostile = () =>
		withOwnProto({ ...GOLDEN_UNSIGNED } as unknown as Record<string, unknown>, { evil: 1 });

	it('reaches the canonical bytes', () => {
		expect(
			canonicalize(attestationSigningView(hostile() as unknown as typeof GOLDEN_UNSIGNED))
		).toBe(`{"__proto__":{"evil":1},${GOLDEN_CANONICAL.slice(1)}`);
	});

	it('does not become the prototype of the signing view', () => {
		const view = attestationSigningView(hostile() as unknown as typeof GOLDEN_UNSIGNED);
		expect(Object.getPrototypeOf(view)).toBeNull();
		expect(Object.hasOwn(view, '__proto__')).toBe(true);
	});

	it('changes the signature, so stripping it fails verification', () => {
		const attestation = signAttestation(
			hostile() as unknown as typeof GOLDEN_UNSIGNED,
			FIXED_PRIVATE_KEY
		);
		expect(attestation.sig).not.toBe(GOLDEN_SIGNATURE);
		expect(verifyAttestationSignature(attestation, FIXED_PUBLIC_KEY)).toBe(true);

		const stripped: Record<string, unknown> = {};
		for (const key of Object.keys(attestation)) {
			if (key === '__proto__') continue;
			stripped[key] = (attestation as unknown as Record<string, unknown>)[key];
		}
		expect(verifyAttestationSignature(stripped as unknown as Attestation, FIXED_PUBLIC_KEY)).toBe(
			false
		);
	});

	it('cannot be added to a document signed without it', () => {
		const forged = withOwnProto({ ...signed() } as unknown as Record<string, unknown>, { evil: 1 });
		expect(verifyAttestationSignature(forged as unknown as Attestation, FIXED_PUBLIC_KEY)).toBe(
			false
		);
	});
});

describe('tamper detection', () => {
	it.each([
		['v', (doc: Record<string, unknown>) => (doc['v'] = 2)],
		['kind', (doc: Record<string, unknown>) => (doc['kind'] = 'trap-hit')],
		['observer', (doc: Record<string, unknown>) => (doc['observer'] = 'mx.evil.example')],
		['subject', (doc: Record<string, unknown>) => (doc['subject'] = { domain: 'victim.com' })],
		[
			'subject (added ip)',
			(doc: Record<string, unknown>) => {
				(doc['subject'] as Record<string, unknown>)['ip'] = '192.0.2.7';
			},
		],
		[
			'window.from',
			(doc: Record<string, unknown>) => {
				(doc['window'] as Record<string, unknown>)['from'] = '2026-08-18T00:00:00Z';
			},
		],
		[
			'window (removed)',
			(doc: Record<string, unknown>) => {
				delete doc['window'];
			},
		],
		[
			'body count',
			(doc: Record<string, unknown>) => {
				(doc['body'] as Record<string, unknown>)['messages'] = 1201;
			},
		],
		[
			'body (added field)',
			(doc: Record<string, unknown>) => {
				(doc['body'] as Record<string, unknown>)['extra'] = 0;
			},
		],
		[
			'body (removed field)',
			(doc: Record<string, unknown>) => {
				delete (doc['body'] as Record<string, unknown>)['bounceRateBucket'];
			},
		],
		[
			'number widening (1200 -> 1200.0000001)',
			(doc: Record<string, unknown>) => {
				(doc['body'] as Record<string, unknown>)['messages'] = 1200.0000001;
			},
		],
		[
			'string case (Example.com)',
			(doc: Record<string, unknown>) => {
				(doc['subject'] as Record<string, unknown>)['domain'] = 'Example.com';
			},
		],
	])('rejects a document whose %s was altered after signing', (_label, mutate) => {
		expect(verifyAttestationSignature(tampered(mutate), FIXED_PUBLIC_KEY)).toBe(false);
	});

	it('refuses to verify a version it does not implement the rule for', () => {
		// `v` is the only field binding a document to a signing scheme — the
		// `ed25519:` label sits outside the signed bytes.
		const v2 = signAttestation(
			{ ...GOLDEN_UNSIGNED, v: 2 as unknown as 1 },
			FIXED_PRIVATE_KEY
		) as unknown as Attestation;
		expect(verifyAttestationSignature(v2, FIXED_PUBLIC_KEY)).toBe(false);
	});

	it('rejects a signature flipped by one bit', () => {
		const attestation = signed();
		const raw = Buffer.from(attestation.sig.slice(ATTESTATION_SIGNATURE_PREFIX.length), 'base64');
		raw[10] = (raw[10] ?? 0) ^ 0x01;
		expect(
			verifyAttestationSignature(
				{ ...attestation, sig: `${ATTESTATION_SIGNATURE_PREFIX}${raw.toString('base64')}` },
				FIXED_PUBLIC_KEY
			)
		).toBe(false);
	});

	it('rejects a valid signature by another key', () => {
		const other = generateEd25519KeyPair();
		expect(
			verifyAttestationSignature(
				signAttestation(GOLDEN_UNSIGNED, other.privateKey),
				FIXED_PUBLIC_KEY
			)
		).toBe(false);
	});

	it('rejects a signature lifted from a different attestation by the same key', () => {
		const other = signAttestation(
			{ ...GOLDEN_UNSIGNED, subject: { domain: 'other.example' } },
			FIXED_PRIVATE_KEY
		);
		expect(verifyAttestationSignature({ ...signed(), sig: other.sig }, FIXED_PUBLIC_KEY)).toBe(
			false
		);
	});
});

describe('isAttestationSignature', () => {
	it('accepts what signAttestation produces', () => {
		expect(isAttestationSignature(signed().sig)).toBe(true);
	});

	it.each([
		['unprefixed', GOLDEN_SIGNATURE.slice(ATTESTATION_SIGNATURE_PREFIX.length)],
		['another algorithm', GOLDEN_SIGNATURE.replace('ed25519:', 'rsa:')],
		['63 bytes', `ed25519:${Buffer.alloc(63).toString('base64')}`],
		['65 bytes', `ed25519:${Buffer.alloc(65).toString('base64')}`],
		['base64url', `ed25519:${Buffer.alloc(64, 251).toString('base64url')}`],
		['not a string', 42],
		['missing', undefined],
	])('rejects a signature that is %s', (_label, value) => {
		expect(isAttestationSignature(value)).toBe(false);
	});
});

describe('verifyAttestationSignature is total', () => {
	const malformed: Array<[string, unknown]> = [
		['null', null],
		['undefined', undefined],
		['a string', 'ed25519:whatever'],
		['an array', []],
		['a document without sig', { ...GOLDEN_UNSIGNED }],
		['a numeric sig', { ...GOLDEN_UNSIGNED, sig: 42 }],
		['an unprefixed sig', { ...GOLDEN_UNSIGNED, sig: 'AAAA' }],
		['a wrong-algorithm sig', { ...GOLDEN_UNSIGNED, sig: 'rsa:AAAA' }],
		['a non-base64 sig', { ...GOLDEN_UNSIGNED, sig: 'ed25519:!!!!' }],
		['a short sig', { ...GOLDEN_UNSIGNED, sig: `ed25519:${Buffer.alloc(63).toString('base64')}` }],
		[
			'a body JCS cannot serialize',
			{ ...GOLDEN_UNSIGNED, sig: GOLDEN_SIGNATURE, body: { n: Number.POSITIVE_INFINITY } },
		],
	];

	it.each(malformed)('answers false for %s instead of throwing', (_label, value) => {
		expect(verifyAttestationSignature(value as Attestation, FIXED_PUBLIC_KEY)).toBe(false);
	});

	it.each([
		['empty', ''],
		['garbage', 'not-a-key'],
		['31 bytes', Buffer.alloc(31).toString('base64')],
		['a 32-byte key with whitespace', ` ${FIXED_PUBLIC_KEY} `],
	])('answers false for a %s public key', (_label, key) => {
		expect(verifyAttestationSignature(signed(), key)).toBe(false);
	});
});
