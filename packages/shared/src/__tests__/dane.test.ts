/**
 * DANE / TLSA parse + match unit matrix (RFC 6698 / RFC 7672).
 *
 * The certificate vectors below are pinned constants: the SHA-256/SHA-512 of the
 * fixture certificate's full DER (selector 0) and of its SubjectPublicKeyInfo
 * (selector 1), computed offline. Asserting against literal hex — rather than
 * re-deriving with the same primitives the code uses — makes this a genuine test
 * vector, not a tautology, and pins the selector/matching-type wiring.
 */
import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import {
	parseTlsaRecord,
	formatTlsaRecord,
	tlsaRecordsEqual,
	isUsableForSmtp,
	hasUsableTlsa,
	computeAssociation,
	matchCertificateToTlsa,
	DANE_SELECTOR,
	DANE_MATCHING,
	type TlsaRecord,
} from '../dane';

// A throwaway self-signed certificate (CN=mx.test) used only as a byte source
// for the association vectors below.
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDGzCCAgOgAwIBAgIUU8wA0vZJyVLEAPBXwhc4Ynmfm9wwDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHbXgudGVzdDAgFw0yNjA2MjEyMjE4MTZaGA8yMTI2MDUy
ODIyMTgxNlowEjEQMA4GA1UEAwwHbXgudGVzdDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAMuPIa32AonH2RDNH3wza2U+7djkJ7oy4IYuIW0hdCtv73RS
BF4SK/3ItjFutEuEKiWkS0LQzcQgqDmc1C+sqzaEsrCBva7M1Ldn+Z/12vVxpxqd
fDjcVhAaTdUp8MyNnXxehbqN6F3n62jE1GbS95KMPff2vIKagRtQmczFKGjfXAvl
Q0RCsi8fLAnuvIlWKc6kiMcrlVsJg2tNBG32OfQ+Xqu3/sOb2Fny58M+7Bi0wI1M
4MzF9HzQnhCBrD9l3ffP2QhKGqfX8jEjj31O2NF8VvtN8Jmxulfg8WYdAm2Udwba
7fz1J/47pmDVH7G7zujR+bT85dGppprT0GEQUv0CAwEAAaNnMGUwHQYDVR0OBBYE
FDMELoIfPTcqugnVeJi2YPM2biM2MB8GA1UdIwQYMBaAFDMELoIfPTcqugnVeJi2
YPM2biM2MA8GA1UdEwEB/wQFMAMBAf8wEgYDVR0RBAswCYIHbXgudGVzdDANBgkq
hkiG9w0BAQsFAAOCAQEAtJ0a4ri47YY+7ICDbFNvi+UzAbr68jqxbciyyyr3Wqf5
TS2vt8X4HEKibvOrBqKeJ45Pgi1MFet5dZJ7hnthYDdVgBda1bya0XWADqx/Rd1T
/dOOLw4811Gv7ghq6bByZmJ6u03rGmdKYeux9tdykp3sU0nbGV6jD92ZwTXtTDyY
BX12lAx1878oNY2IFwe+fnEEkZ2nn7oBO8PHR7ikDi76jOYNpWup1sI1xLZBC7/Q
pVQBsZMgPVS9KbTucsDVoVC80/qXOijWzSBhpaNs6KNpZwV9Dv8Ygkt2/B4AMVRx
iFesNOfoRng4W1hZ5KgWbWodnzs48/hMrvH7wz80PA==
-----END CERTIFICATE-----`;

const CERT_DER = new X509Certificate(FIXTURE_CERT_PEM).raw;

// Offline-computed association vectors for the fixture certificate.
const VEC = {
	fullSha256: '16a88ed94b750bb3024edfea430b96b3e4bee7b92a14813d537f4902ee8ad54f',
	fullSha512:
		'aede4a36e7eb777b7958e549708a64a8e938449f5aa67a9f054144f3483c58b9bf5bcc0831af3af76ab626ea87bfc422fbccaf42adee84872828b6b2e69da05a',
	spkiSha256: '49fc4a5424807bbbde5617d8b4bb563a79f4566c28d4d9b2e917dddcc7bac89c',
	spkiSha512:
		'1428f359ff4c9c73e6edbd5a8f805bbb6c77595358f47b75250e372b4ec0b20c4118744d8645749a88dff21437f6fb23ad89e1b008957b7386cd660a2f40ea38',
};

describe('parseTlsaRecord', () => {
	it('parses the presentation form "<usage> <selector> <matching> <hex>"', () => {
		expect(parseTlsaRecord('3 1 1 49fc4a5424807bbb')).toEqual({
			usage: 3,
			selector: 1,
			matchingType: 1,
			data: '49fc4a5424807bbb',
		});
	});

	it('lowercases and joins hex split across whitespace (DNS presentation form)', () => {
		expect(parseTlsaRecord('2 0 1 16A88ED9 4B750BB3')?.data).toBe('16a88ed94b750bb3');
	});

	it('rejects too-few fields, non-integer parameters, and non-hex/odd data', () => {
		expect(parseTlsaRecord('3 1 1')).toBeNull();
		expect(parseTlsaRecord('x 1 1 abcd')).toBeNull();
		expect(parseTlsaRecord('3 1 1 xyz')).toBeNull();
		expect(parseTlsaRecord('3 1 1 abc')).toBeNull(); // odd length
		expect(parseTlsaRecord('3 1 1 ')).toBeNull();
	});
});

describe('tlsaRecordsEqual', () => {
	const base: TlsaRecord = { usage: 3, selector: 1, matchingType: 1, data: 'abcd' };
	it('is true only when all four fields match', () => {
		expect(tlsaRecordsEqual(base, { ...base })).toBe(true);
		expect(tlsaRecordsEqual(base, { ...base, usage: 2 })).toBe(false);
		expect(tlsaRecordsEqual(base, { ...base, selector: 0 })).toBe(false);
		expect(tlsaRecordsEqual(base, { ...base, matchingType: 2 })).toBe(false);
		expect(tlsaRecordsEqual(base, { ...base, data: 'ef01' })).toBe(false);
	});
});

describe('isUsableForSmtp / hasUsableTlsa (RFC 7672 §2.1)', () => {
	it('accepts only DANE-TA(2)/DANE-EE(3) with a known selector + matching type', () => {
		expect(isUsableForSmtp({ usage: 3, selector: 1, matchingType: 1, data: 'ab' })).toBe(true);
		expect(isUsableForSmtp({ usage: 2, selector: 0, matchingType: 2, data: 'ab' })).toBe(true);
	});
	it('rejects PKIX usages (0/1) and unknown selector/matching type', () => {
		expect(isUsableForSmtp({ usage: 0, selector: 1, matchingType: 1, data: 'ab' })).toBe(false);
		expect(isUsableForSmtp({ usage: 1, selector: 1, matchingType: 1, data: 'ab' })).toBe(false);
		expect(isUsableForSmtp({ usage: 3, selector: 2, matchingType: 1, data: 'ab' })).toBe(false);
		expect(isUsableForSmtp({ usage: 3, selector: 1, matchingType: 9, data: 'ab' })).toBe(false);
	});
	it('hasUsableTlsa is true when any record is SMTP-usable', () => {
		expect(
			hasUsableTlsa([
				{ usage: 0, selector: 1, matchingType: 1, data: 'ab' },
				{ usage: 3, selector: 1, matchingType: 1, data: 'cd' },
			])
		).toBe(true);
		expect(hasUsableTlsa([{ usage: 1, selector: 1, matchingType: 1, data: 'ab' }])).toBe(false);
	});
});

describe('computeAssociation — selector × matching-type grid (RFC 6698 §2.1)', () => {
	it('selector 0 (full cert) × SHA-256 / SHA-512', () => {
		expect(computeAssociation(CERT_DER, DANE_SELECTOR.FULL_CERT, DANE_MATCHING.SHA256)).toBe(
			VEC.fullSha256
		);
		expect(computeAssociation(CERT_DER, DANE_SELECTOR.FULL_CERT, DANE_MATCHING.SHA512)).toBe(
			VEC.fullSha512
		);
	});
	it('selector 1 (SPKI) × SHA-256 / SHA-512', () => {
		expect(computeAssociation(CERT_DER, DANE_SELECTOR.SPKI, DANE_MATCHING.SHA256)).toBe(
			VEC.spkiSha256
		);
		expect(computeAssociation(CERT_DER, DANE_SELECTOR.SPKI, DANE_MATCHING.SHA512)).toBe(
			VEC.spkiSha512
		);
	});
	it('matching type 0 (exact) returns the full selected DER as hex', () => {
		const exact = computeAssociation(CERT_DER, DANE_SELECTOR.FULL_CERT, DANE_MATCHING.EXACT);
		expect(exact).toBe(CERT_DER.toString('hex'));
	});
	it('returns null for an unknown selector or matching type', () => {
		expect(computeAssociation(CERT_DER, 9, DANE_MATCHING.SHA256)).toBeNull();
		expect(computeAssociation(CERT_DER, DANE_SELECTOR.SPKI, 9)).toBeNull();
	});
});

describe('matchCertificateToTlsa (RFC 7672)', () => {
	it('DANE-EE(3) selector 1 SHA-256 authenticates the leaf', () => {
		const result = matchCertificateToTlsa({ leafDer: CERT_DER }, [
			{ usage: 3, selector: 1, matchingType: 1, data: VEC.spkiSha256 },
		]);
		expect(result).toEqual({
			usable: true,
			matched: true,
			matchedRecord: { usage: 3, selector: 1, matchingType: 1, data: VEC.spkiSha256 },
		});
	});

	it('DANE-EE(3) selector 0 SHA-512 authenticates the leaf', () => {
		const result = matchCertificateToTlsa({ leafDer: CERT_DER }, [
			{ usage: 3, selector: 0, matchingType: 2, data: VEC.fullSha512 },
		]);
		expect(result.matched).toBe(true);
	});

	it('usable-but-no-match => { usable: true, matched: false } (fail closed)', () => {
		const result = matchCertificateToTlsa({ leafDer: CERT_DER }, [
			{ usage: 3, selector: 1, matchingType: 1, data: 'deadbeef'.repeat(8) },
		]);
		expect(result).toEqual({ usable: true, matched: false });
	});

	it('no usable records => { usable: false, matched: false } (fall back to non-DANE)', () => {
		const result = matchCertificateToTlsa({ leafDer: CERT_DER }, [
			{ usage: 0, selector: 1, matchingType: 1, data: VEC.spkiSha256 },
			{ usage: 1, selector: 0, matchingType: 1, data: VEC.fullSha256 },
		]);
		expect(result).toEqual({ usable: false, matched: false });
	});

	it('DANE-EE(3) does NOT match a non-leaf chain member (leaf-only)', () => {
		// A DANE-EE record whose hash matches a CA-only cert in the chain must not
		// authenticate: usage 3 pins the end-entity certificate exclusively.
		const otherDer = Buffer.from('00', 'hex');
		const result = matchCertificateToTlsa({ leafDer: otherDer, chainDer: [otherDer, CERT_DER] }, [
			{ usage: 3, selector: 1, matchingType: 1, data: VEC.spkiSha256 },
		]);
		expect(result.matched).toBe(false);
	});

	it('DANE-TA(2) matches a trust anchor anywhere in the presented chain', () => {
		const leaf = Buffer.from('00', 'hex');
		const result = matchCertificateToTlsa({ leafDer: leaf, chainDer: [leaf, CERT_DER] }, [
			{ usage: 2, selector: 1, matchingType: 1, data: VEC.spkiSha256 },
		]);
		expect(result.matched).toBe(true);
	});
});

describe('formatTlsaRecord', () => {
	it('renders the RFC 6698 §2.2 presentation form and round-trips through parseTlsaRecord', () => {
		const record: TlsaRecord = { usage: 3, selector: 1, matchingType: 1, data: VEC.spkiSha256 };
		expect(formatTlsaRecord(record)).toBe(`3 1 1 ${VEC.spkiSha256}`);
		expect(parseTlsaRecord(formatTlsaRecord(record))).toEqual(record);
	});
});
