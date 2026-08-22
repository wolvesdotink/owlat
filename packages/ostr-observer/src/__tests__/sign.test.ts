import { describe, expect, it } from 'vitest';
import {
	generateEd25519KeyPair,
	validateAttestation,
	verifyAttestationSignature,
	type TrafficSummaryBody,
} from '@owlat/ostr-core';
import { draftToUnsigned, signDrafts } from '../sign.js';
import { TrafficAccumulator } from '../traffic.js';
import { buildReportedWindow } from '../spamBatch.js';
import type { AttestationDraft, ObserverIdentity } from '../types.js';

const keys = generateEd25519KeyPair();
const identity: ObserverIdentity = {
	domain: 'mx.hinterland.camp',
	privateKeyBase64: keys.privateKey,
};

function summaryDrafts(): AttestationDraft<TrafficSummaryBody>[] {
	const accumulator = new TrafficAccumulator();
	for (let i = 0; i < 40; i++) {
		accumulator.observe({
			signingDomain: 'example.com',
			ip: '192.0.2.7',
			spfPass: true,
			dkimPass: true,
			dmarcPass: i % 2 === 0,
			tls: true,
			recipientCount: 1,
			bounced: i % 20 === 0,
			recipients: [`mbx-${i % 8}`],
		});
	}
	return accumulator.emitTrafficSummaries({
		windowFrom: '2026-08-19T00:00:00Z',
		windowTo: '2026-08-20T00:00:00Z',
	}).emitted;
}

describe('signDrafts round-trip', () => {
	it('produces attestations the core validates and verifies', () => {
		const drafts = summaryDrafts();
		expect(drafts.length).toBeGreaterThan(0);
		const signed = signDrafts(identity, drafts);
		expect(signed).toHaveLength(drafts.length);
		for (const attestation of signed) {
			expect(validateAttestation(attestation).ok).toBe(true);
			expect(verifyAttestationSignature(attestation, keys.publicKey)).toBe(true);
			expect(attestation.observer).toBe('mx.hinterland.camp');
			expect(attestation.v).toBe(1);
		}
	});

	it('fails verification under a different key', () => {
		const [attestation] = signDrafts(identity, summaryDrafts());
		expect(attestation).toBeDefined();
		if (attestation === undefined) return;
		expect(verifyAttestationSignature(attestation, generateEd25519KeyPair().publicKey)).toBe(false);
	});

	it('does not verify after a single body byte is edited', () => {
		const [attestation] = signDrafts(identity, summaryDrafts());
		if (attestation === undefined) return;
		const tampered = {
			...attestation,
			body: { ...(attestation.body as TrafficSummaryBody), messages: 4000 },
		};
		expect(verifyAttestationSignature(tampered, keys.publicKey)).toBe(false);
	});

	it('signs the §7.3 pair as two records under one identity', () => {
		const [summary] = summaryDrafts();
		expect(summary).toBeDefined();
		if (summary === undefined) return;
		const paired = buildReportedWindow({
			summary,
			batch: {
				subject: summary.subject,
				window: summary.window as { from: string; to: string },
				bundles: ['a', 'b', 'c'].map((letter, index) => ({
					bundleHash: letter.repeat(64),
					signingDomain: 'example.com',
					reporter: `reporter-${index}`,
				})),
			},
		});
		expect(paired.ok).toBe(true);
		if (!paired.ok) return;
		const signed = signDrafts(identity, paired.drafts);
		expect(signed.map((attestation) => attestation.kind)).toEqual([
			'traffic-summary',
			'spam-report-batch',
		]);
		for (const attestation of signed) {
			expect(validateAttestation(attestation).ok).toBe(true);
			expect(verifyAttestationSignature(attestation, keys.publicKey)).toBe(true);
		}
	});

	it('folds the observer domain and omits an absent window', () => {
		const unsigned = draftToUnsigned('MX.Hinterland.Camp', {
			kind: 'posture',
			subject: { domain: 'example.com' },
			body: { dnssec: true },
		});
		expect(Object.hasOwn(unsigned, 'window')).toBe(false);

		const [signed] = signDrafts({ ...identity, domain: 'MX.Hinterland.Camp.' }, [
			{ kind: 'posture', subject: { domain: 'example.com' }, body: { dnssec: true } },
		]);
		expect(signed).toBeDefined();
		if (signed === undefined) return;
		expect(signed.observer).toBe('mx.hinterland.camp');
		expect(verifyAttestationSignature(signed, keys.publicKey)).toBe(true);
	});

	it('throws rather than publishing an identity or a draft the log would reject', () => {
		expect(() => signDrafts({ ...identity, domain: 'not a domain' }, [])).toThrow(RangeError);
		expect(() =>
			signDrafts(identity, [{ kind: 'traffic-summary', subject: {}, body: { messages: -1 } }])
		).toThrow(/traffic-summary/);
	});
});
