/**
 * Fixture corpus for the aggregator tests.
 *
 * The scenarios mirror the scoring package's golden corpus — a veteran domain
 * with sustained clean history, an abusive domain that several unrelated
 * observers report, a bare IP under the same treatment, and a tenant on a
 * shared IP — but every attestation here is really signed by a generated
 * observer key, so the fixtures exercise the same records a live log holds.
 */

import { generateEd25519KeyPair, signAttestation } from '@owlat/ostr-core';
import type {
	Attestation,
	AttestationKind,
	LogEntryRef,
	SequencedAttestation,
	SubjectRef,
} from '@owlat/ostr-core';

export const AS_OF = '2026-08-20T00:00:00Z';

/** Four unrelated observers, four keys — diversity the §6.3 bounds actually count. */
export const OBSERVERS = [
	'mx.observer-a.net',
	'mail.observer-b.org',
	'smtp.observer-c.example',
	'gw.observer-d.example',
] as const;

export type ObserverName = (typeof OBSERVERS)[number];

const KEYS = new Map<string, string>(
	OBSERVERS.map((observer) => [observer, generateEd25519KeyPair().privateKey])
);

/** An unsequenced log entry: what {@link FakeLog.append} takes. */
export interface PendingEntry {
	loggedAt: string;
	attestation: Attestation;
}

interface EntryInput {
	kind: AttestationKind;
	observer: string;
	subject: SubjectRef;
	body: unknown;
	loggedAt: string;
	window?: { from: string; to: string };
}

function signedEntry(input: EntryInput): PendingEntry {
	const key = KEYS.get(input.observer) ?? generateEd25519KeyPair().privateKey;
	KEYS.set(input.observer, key);
	const unsigned = {
		v: 1 as const,
		kind: input.kind,
		observer: input.observer,
		subject: input.subject,
		...(input.window === undefined ? {} : { window: input.window }),
		body: input.body,
	};
	return { loggedAt: input.loggedAt, attestation: signAttestation(unsigned, key) };
}

interface TrafficInput {
	observer: string;
	subject: SubjectRef;
	messages: number;
	passRate: number;
	from: string;
	to: string;
	loggedAt: string;
	bounceRateBucket?: number;
}

function traffic(input: TrafficInput): PendingEntry {
	const passes = Math.round(input.messages * input.passRate);
	return signedEntry({
		kind: 'traffic-summary',
		observer: input.observer,
		subject: input.subject,
		window: { from: input.from, to: input.to },
		loggedAt: input.loggedAt,
		body: {
			messages: input.messages,
			spfPass: passes,
			dkimPass: passes,
			dmarcPass: passes,
			tlsInbound: input.messages,
			uniqueRecipientsBucket: 4,
			bounceRateBucket: input.bounceRateBucket ?? 0,
		},
	});
}

const COMMITMENT = 'a3f1c0d9b8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1';

function reports(observer: string, subject: SubjectRef, count: number): PendingEntry {
	return signedEntry({
		kind: 'spam-report-batch',
		observer,
		subject,
		window: { from: '2026-07-31T00:00:00Z', to: '2026-08-18T00:00:00Z' },
		loggedAt: '2026-08-18T00:00:00Z',
		body: { reports: count, commitment: COMMITMENT },
	});
}

function trapHits(observer: string, subject: SubjectRef, hits: number): PendingEntry {
	return signedEntry({
		kind: 'trap-hit',
		observer,
		subject,
		window: { from: '2026-08-05T00:00:00Z', to: '2026-08-18T00:00:00Z' },
		loggedAt: '2026-08-18T00:00:00Z',
		body: { hits },
	});
}

/** Sustained, high-volume, well-authenticated history across four observers. */
function veteran(): PendingEntry[] {
	const subject: SubjectRef = { domain: 'veteran.example' };
	const opened = [
		'2025-02-26T00:00:00Z',
		'2025-04-07T00:00:00Z',
		'2025-04-27T00:00:00Z',
		'2025-05-17T00:00:00Z',
	];
	const closed = [
		'2025-03-28T00:00:00Z',
		'2025-05-07T00:00:00Z',
		'2025-05-27T00:00:00Z',
		'2025-06-16T00:00:00Z',
	];
	const early = [9000, 6000, 4500, 3000];
	const late = [140_000, 95_000, 72_000, 48_000];
	const entries: PendingEntry[] = [
		signedEntry({
			kind: 'posture',
			observer: 'veteran.example',
			subject,
			loggedAt: '2024-12-28T00:00:00Z',
			body: {
				dmarcPolicy: 'reject',
				dmarcAlignment: 'strict',
				dnssec: true,
				mtaSts: true,
				tlsRpt: true,
				registeredBefore: '2021-02-27T00:00:00Z',
			},
		}),
	];
	OBSERVERS.forEach((observer, at) => {
		entries.push(
			traffic({
				observer,
				subject,
				messages: early[at] as number,
				passRate: 0.995,
				from: opened[at] as string,
				to: closed[at] as string,
				loggedAt: closed[at] as string,
			}),
			traffic({
				observer,
				subject,
				messages: late[at] as number,
				passRate: 0.995,
				from: opened[at] as string,
				to: '2026-08-18T00:00:00Z',
				loggedAt: '2026-08-18T00:00:00Z',
			})
		);
	});
	return entries;
}

/** Complaints and trap hits from four unrelated observers: the flagged diversity rule is met. */
function abusive(subject: SubjectRef): PendingEntry[] {
	const volumes = [90_000, 70_000, 60_000, 50_000];
	const entries = OBSERVERS.map((observer, at) =>
		traffic({
			observer,
			subject,
			messages: volumes[at] as number,
			passRate: 0.6,
			from: '2026-07-11T00:00:00Z',
			to: '2026-08-17T00:00:00Z',
			loggedAt: '2026-08-19T00:00:00Z',
			bounceRateBucket: 2,
		})
	);
	entries.push(
		reports(OBSERVERS[0], subject, 900),
		reports(OBSERVERS[1], subject, 700),
		reports(OBSERVERS[2], subject, 640),
		trapHits(OBSERVERS[3], subject, 80),
		trapHits(OBSERVERS[0], subject, 40)
	);
	return entries;
}

/** One tenant of a shared IP: evidence naming both the IP and the domain (D2). */
function tenant(): PendingEntry[] {
	return [
		traffic({
			observer: OBSERVERS[1],
			subject: { domain: 'tenant.example', ip: '203.0.113.9' },
			messages: 4000,
			passRate: 1,
			from: '2026-06-20T00:00:00Z',
			to: '2026-08-18T00:00:00Z',
			loggedAt: '2026-08-18T00:00:00Z',
		}),
	];
}

/**
 * The corpus, in log order: a trusted veteran, a flagged domain, a flagged bare
 * IP, and a shared-IP tenant whose evidence names both an address and a domain
 * and is therefore scored as the domain.
 */
export function corpus(): PendingEntry[] {
	return [
		...veteran(),
		...abusive({ domain: 'abusive.example' }),
		...abusive({ ip: '198.51.100.7' }),
		...tenant(),
	];
}

/** A further clean window for the veteran — the "nothing moved" refresh's counterpart. */
export function laterVeteranEntry(): PendingEntry {
	return traffic({
		observer: OBSERVERS[0],
		subject: { domain: 'veteran.example' },
		messages: 150_000,
		passRate: 0.995,
		from: '2025-02-26T00:00:00Z',
		to: '2026-08-19T00:00:00Z',
		loggedAt: '2026-08-19T00:00:00Z',
	});
}

/**
 * A domain claiming an address range as its own (D2). Evidence on a bare IP in
 * the range then reaches the domain, even though it never named the domain.
 */
export function declaredRangePosture(domain: string, declaredIps: readonly string[]): PendingEntry {
	return signedEntry({
		kind: 'posture',
		observer: domain,
		subject: { domain },
		loggedAt: '2026-08-10T00:00:00Z',
		body: { dmarcPolicy: 'reject', dnssec: true, declaredIps: [...declaredIps] },
	});
}

/**
 * A retraction of one of an observer's own entries. The policy excludes the
 * target only when the retraction is authored by the same observer, so the
 * caller must pass the target's author.
 */
export function retractionEntry(input: {
	observer: string;
	subject: SubjectRef;
	supersedes: LogEntryRef;
	loggedAt?: string;
}): PendingEntry {
	return signedEntry({
		kind: 'retraction',
		observer: input.observer,
		subject: input.subject,
		loggedAt: input.loggedAt ?? '2026-08-19T12:00:00Z',
		body: { supersedes: input.supersedes, reason: 'measurement error on our side' },
	});
}

/** Entries for a domain nobody has said anything negative about, at low volume. */
export function newcomerEntries(): PendingEntry[] {
	return [
		traffic({
			observer: OBSERVERS[2],
			subject: { domain: 'newcomer.example' },
			messages: 800,
			passRate: 1,
			from: '2026-08-01T00:00:00Z',
			to: '2026-08-18T00:00:00Z',
			loggedAt: '2026-08-18T00:00:00Z',
		}),
	];
}

export type { SequencedAttestation };
