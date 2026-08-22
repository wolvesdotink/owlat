/**
 * Fixture builders shared by the HTTP tests: a real observer key pair, real
 * signed attestations, and a canned score result.
 *
 * Nothing here fabricates a signature or a hash. The submit tests sign with
 * `@owlat/ostr-core`'s `signAttestation` over the same canonical form the log
 * verifies, so a passing round-trip test proves the wire path, not the fixture.
 */
import {
	generateEd25519KeyPair,
	signAttestation,
	type Attestation,
	type ScoreResult,
	type SequencedAttestation,
	type SnapshotFile,
	type SubjectRef,
	type TrafficSummaryBody,
	type UnsignedAttestation,
} from '@owlat/ostr-core';
import { FAKE_LOG_ID, FakeKeyDirectory, FakeRegistryLog } from './fakes.js';

export const OBSERVER = 'mx.observer.test';

export interface SignedObserver {
	domain: string;
	publicKey: string;
	privateKey: string;
}

export function makeObserver(domain: string = OBSERVER): SignedObserver {
	const { publicKey, privateKey } = generateEd25519KeyPair();
	return { domain, publicKey, privateKey };
}

const BODY: TrafficSummaryBody = {
	messages: 1000,
	spfPass: 990,
	dkimPass: 985,
	dmarcPass: 980,
	tlsInbound: 1000,
	uniqueRecipientsBucket: 3,
	bounceRateBucket: 1,
};

export function trafficSummary(
	observer: SignedObserver,
	subject: SubjectRef = { domain: 'sender.example' },
	overrides: Partial<UnsignedAttestation<TrafficSummaryBody>> = {}
): Attestation<TrafficSummaryBody> {
	const unsigned: UnsignedAttestation<TrafficSummaryBody> = {
		v: 1,
		kind: 'traffic-summary',
		observer: observer.domain,
		subject,
		window: { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' },
		body: BODY,
		...overrides,
	};
	return signAttestation(unsigned, observer.privateKey);
}

/** A log fake that trusts exactly `observers`, plus its own signing key pair. */
export function makeLog(observers: readonly SignedObserver[]): {
	log: FakeRegistryLog;
	logPublicKey: string;
} {
	const keyPair = generateEd25519KeyPair();
	const directory = new FakeKeyDirectory(
		new Map(observers.map((observer) => [observer.domain, [observer.publicKey]]))
	);
	return {
		log: new FakeRegistryLog(directory, keyPair.privateKey),
		logPublicKey: keyPair.publicKey,
	};
}

export const SCORE: ScoreResult = {
	subject: { domain: 'sender.example' },
	tier: 'trusted',
	score: 87,
	policy: 'ostr-policy-v1',
	explanation: [
		{
			signal: 'authentication',
			contribution: 12,
			summary: 'DMARC alignment held across the observed window.',
			evidence: [{ logId: FAKE_LOG_ID, index: 0 }],
		},
	],
};

export const IPV6_SCORE: ScoreResult = {
	...SCORE,
	subject: { ip: '2001:db8::1' },
	tier: 'flagged',
	score: 4,
};

export const IPV4_SCORE: ScoreResult = { ...SCORE, subject: { ip: '192.0.2.7' }, tier: 'warned' };

export function sequenced(index: number, attestation: Attestation): SequencedAttestation {
	return { logId: FAKE_LOG_ID, index, loggedAt: '2026-08-20T00:00:00Z', attestation };
}

export const SNAPSHOT: SnapshotFile = {
	v: 1,
	policy: 'ostr-policy-v1',
	asOf: '2026-08-20T06:00:00Z',
	heads: [],
	entries: [{ subject: { domain: 'sender.example' }, tier: 'trusted', score: 87 }],
	sig: 'ed25519:AA==',
};
