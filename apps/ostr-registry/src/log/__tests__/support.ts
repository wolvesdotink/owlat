/**
 * Fixtures for the log tests: a throwaway SQLite file per test, a fake
 * `_ostr.<domain>` key directory over generated keys, and signed attestations.
 *
 * Keys are generated rather than fixed: nothing here asserts on signature
 * bytes (ostr-core owns those vectors), only on accept/reject behaviour.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Attestation,
	type AttestationKind,
	formatOstrKeyRecord,
	generateEd25519KeyPair,
	signAttestation,
	type UnsignedAttestation,
} from '@owlat/ostr-core';
import type { KeyDirectory } from '../../contracts.js';
import { SqliteRegistryLog } from '../sqliteLog.js';

export const LOG_ID = 'log.ostr.test';

/** A directory of published TXT records, keyed by observer domain. */
export class FakeKeyDirectory implements KeyDirectory {
	readonly records = new Map<string, string[]>();
	readonly lookups: string[] = [];
	/** When set, every lookup rejects with it — a nameserver that is down. */
	outage: Error | null = null;
	private waiters: Array<() => void> | null = null;

	publish(domain: string, ...records: string[]): void {
		this.records.set(domain, records);
	}

	/**
	 * Suspend every lookup started from now on; the returned function resumes
	 * them. Lets a test hold two submissions inside the same await and check
	 * what the log does when they both come back.
	 */
	deferLookups(): () => void {
		const waiters: Array<() => void> = [];
		this.waiters = waiters;
		return () => {
			this.waiters = null;
			for (const resume of waiters) resume();
		};
	}

	async verifyingKeys(observerDomain: string): Promise<string[]> {
		this.lookups.push(observerDomain);
		if (this.outage !== null) throw this.outage;
		const waiters = this.waiters;
		if (waiters !== null) {
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
			});
		}
		return this.records.get(observerDomain) ?? [];
	}
}

export interface Observer {
	domain: string;
	publicKey: string;
	privateKey: string;
}

export function makeObserver(domain: string): Observer {
	const { publicKey, privateKey } = generateEd25519KeyPair();
	return { domain, publicKey, privateKey };
}

/** Publishes the observer's key record and returns the observer. */
export function publishObserver(keys: FakeKeyDirectory, domain: string): Observer {
	const observer = makeObserver(domain);
	keys.publish(domain, formatOstrKeyRecord(observer.publicKey));
	return observer;
}

/** A well-formed unsigned `traffic-summary` for `subjectDomain`. */
export function trafficSummary(
	observer: string,
	subjectDomain: string,
	messages = 1200
): UnsignedAttestation {
	return {
		v: 1,
		kind: 'traffic-summary',
		observer,
		subject: { domain: subjectDomain },
		window: { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' },
		body: {
			messages,
			spfPass: messages,
			dkimPass: messages,
			dmarcPass: messages,
			tlsInbound: messages,
			uniqueRecipientsBucket: 2,
			bounceRateBucket: 1,
		},
	};
}

/** A well-formed unsigned attestation of a kind with no window requirement. */
export function unwindowed(
	kind: Extract<AttestationKind, 'posture' | 'vouch'>,
	observer: string,
	subjectDomain: string
): UnsignedAttestation {
	const body =
		kind === 'posture'
			? { dmarcPolicy: 'reject', dnssec: true }
			: { scope: 'transactional mail only', expires: '2027-01-01T00:00:00Z' };
	return { v: 1, kind, observer, subject: { domain: subjectDomain }, body };
}

export function signedBy(observer: Observer, unsigned: UnsignedAttestation): Attestation {
	return signAttestation(unsigned, observer.privateKey);
}

/** A signed attestation from `observer` about `subjectDomain`. */
export function attestationFrom(
	observer: Observer,
	subjectDomain: string,
	messages = 1200
): Attestation {
	return signedBy(observer, trafficSummary(observer.domain, subjectDomain, messages));
}

export interface LogHarness {
	log: SqliteRegistryLog;
	keys: FakeKeyDirectory;
	logKey: { publicKey: string; privateKey: string };
	dbPath: string;
	/** Reopen the same database file with a fresh instance. */
	reopen(): SqliteRegistryLog;
	/** Open a second instance over the same file without closing the first. */
	openAnother(): SqliteRegistryLog;
	cleanup(): void;
}

/** A log over a temp-dir SQLite file, with the fake key directory wired in. */
export function makeLog(mmdSeconds = 3600): LogHarness {
	const dir = mkdtempSync(join(tmpdir(), 'ostr-log-'));
	const dbPath = join(dir, 'log.sqlite');
	const keys = new FakeKeyDirectory();
	const logKey = generateEd25519KeyPair();
	const open = (): SqliteRegistryLog =>
		new SqliteRegistryLog({
			dbPath,
			logId: LOG_ID,
			privateKeyBase64: logKey.privateKey,
			keys,
			mmdSeconds,
		});
	let current = open();
	return {
		get log() {
			return current;
		},
		keys,
		logKey,
		dbPath,
		reopen() {
			current.close();
			current = open();
			return current;
		},
		openAnother: open,
		cleanup() {
			current.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
