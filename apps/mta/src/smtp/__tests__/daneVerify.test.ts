import { X509Certificate } from 'node:crypto';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { computeAssociation, type TlsaRecord } from '@owlat/shared/dane';
import { buildDanePeerVerifier, buildDanePolicyFingerprint } from '../daneVerify.js';
import { MX_CERT } from './certFixture.js';

const certificate = new X509Certificate(MX_CERT);

function socketWithSelfSignedPeer(): TLSSocket {
	const peer = certificate.toLegacyObject() as PeerCertificate & {
		issuerCertificate?: PeerCertificate;
	};
	peer.issuerCertificate = peer;
	return {
		getPeerCertificate: () => peer,
	} as unknown as TLSSocket;
}

function record(usage: 2 | 3, selector: 0 | 1 = 0): TlsaRecord {
	const data = computeAssociation(certificate.raw, selector, 1);
	if (!data) throw new Error('test certificate association could not be computed');
	return { usage, selector, matchingType: 1, data };
}

describe('DANE peer verification', () => {
	it('accepts DANE-EE without applying names or certificate dates', () => {
		const verifier = buildDanePeerVerifier([record(3, 1)], ['wrong.example'], () =>
			Date.parse('2200-01-01T00:00:00Z')
		);
		expect(verifier(socketWithSelfSignedPeer())).toBeUndefined();
	});

	it('accepts a named DANE-TA path and rejects an expired one', () => {
		const records = [record(2)];
		expect(buildDanePeerVerifier(records, ['mx.test'])(socketWithSelfSignedPeer())).toBeUndefined();
		expect(
			buildDanePeerVerifier(records, ['mx.test'], () => Date.parse('2200-01-01T00:00:00Z'))(
				socketWithSelfSignedPeer()
			)
		).toMatchObject({ message: expect.stringContaining('validity period') });
	});

	it('accepts any valid association during a mixed EE/TA rollover', () => {
		const mismatchingEe: TlsaRecord = {
			usage: 3,
			selector: 1,
			matchingType: 1,
			data: '00'.repeat(32),
		};
		const verifier = buildDanePeerVerifier([mismatchingEe, record(2)], ['mx.test']);
		expect(verifier(socketWithSelfSignedPeer())).toBeUndefined();
	});

	it('fingerprints records and reference names independent of DNS answer order', () => {
		const records = [record(2), record(3, 1)];
		expect(buildDanePolicyFingerprint(records, ['mx.test', 'example.test'])).toBe(
			buildDanePolicyFingerprint([...records].reverse(), ['EXAMPLE.TEST.', 'mx.test'])
		);
		expect(buildDanePolicyFingerprint(records, ['mx.test'])).not.toBe(
			buildDanePolicyFingerprint(records, ['other-mx.test'])
		);
	});
});
