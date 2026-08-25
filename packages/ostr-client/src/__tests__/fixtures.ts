/**
 * Fakes for the consumer tests: a resolver, an HTTP fetcher, a clock and a
 * signed snapshot.
 *
 * Every one of them is a plain object handed to the code under test, which is
 * the point of the injection rule — the suite never touches DNS, the network,
 * a disk or the system clock, so it runs identically everywhere and a failure
 * is always about the library.
 */

import {
	generateEd25519KeyPair,
	signSnapshot,
	type DiffFeedEntry,
	type Ed25519KeyPair,
	type SignedTreeHead,
	type SnapshotEntry,
	type SnapshotFile,
	type Tier,
} from '@owlat/ostr-core';
import type { FetchJson } from '../sync.js';
import type { ResolveA, ResolveTxt, TxtRecordSet } from '../index.js';

export const ZONE = 'ostr.example';
export const AS_OF = '2026-08-20T06:00:00Z';

export const HEAD: SignedTreeHead = {
	v: 1,
	logId: 'log.example',
	treeSize: 12,
	rootHash: 'b'.repeat(64),
	timestamp: AS_OF,
	sig: 'ed25519:aGVhZC1zaWduYXR1cmU=',
};

export function entry(subject: SnapshotEntry['subject'], tier: Tier, score: number): SnapshotEntry {
	return { subject, tier, score };
}

export interface SnapshotFixture {
	keys: Ed25519KeyPair;
	snapshot: SnapshotFile;
}

export function signedSnapshot(
	entries: SnapshotEntry[],
	options: { keys?: Ed25519KeyPair; asOf?: string; policy?: string } = {}
): SnapshotFixture {
	const keys = options.keys ?? generateEd25519KeyPair();
	const snapshot = signSnapshot(
		{
			v: 1,
			policy: options.policy ?? 'ostr-policy-v1',
			asOf: options.asOf ?? AS_OF,
			heads: [HEAD],
			entries,
		},
		keys.privateKey
	);
	return { keys, snapshot };
}

export function diff(seq: number, subjectEntry: SnapshotEntry, asOf = AS_OF): DiffFeedEntry {
	return { seq, asOf, entry: subjectEntry };
}

/** A DNS error shaped like the ones `node:dns` throws. */
export function dnsError(code: string): Error & { code: string } {
	return Object.assign(new Error(`queryTxt ${code}`), { code });
}

export interface FakeResolver {
	resolveTxt: ResolveTxt;
	/** Every name queried, in order — the privacy assertions read this. */
	calls: string[];
}

/** A TXT resolver over a fixed name → records map; unknown names are NXDOMAIN. */
export function fakeTxtResolver(records: Record<string, string[][] | Error>): FakeResolver {
	const calls: string[] = [];
	return {
		calls,
		resolveTxt: (name: string): Promise<string[][]> => {
			calls.push(name);
			const found = records[name];
			if (found === undefined) return Promise.reject(dnsError('ENOTFOUND'));
			if (found instanceof Error) return Promise.reject(found);
			return Promise.resolve(found);
		},
	};
}

/**
 * As {@link fakeTxtResolver}, but answering in the TTL-carrying shape, which is
 * what a resolver that has not thrown the record's TTL away hands back.
 */
export function fakeTtlTxtResolver(
	records: Record<string, string[][]>,
	ttlSeconds: number
): FakeResolver {
	const calls: string[] = [];
	return {
		calls,
		resolveTxt: (name: string): Promise<TxtRecordSet> => {
			calls.push(name);
			const found = records[name];
			if (found === undefined) return Promise.reject(dnsError('ENOTFOUND'));
			return Promise.resolve({ records: found, ttlSeconds });
		},
	};
}

export function fakeAResolver(records: Record<string, string[] | Error>): {
	resolveA: ResolveA;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		resolveA: (name: string): Promise<string[]> => {
			calls.push(name);
			const found = records[name];
			if (found === undefined) return Promise.reject(dnsError('ENOTFOUND'));
			if (found instanceof Error) return Promise.reject(found);
			return Promise.resolve(found);
		},
	};
}

export interface FakeFetcher {
	fetchJson: FetchJson;
	calls: string[];
}

/** An HTTP fake over a fixed path → payload map. */
export function fakeFetcher(routes: Record<string, unknown>): FakeFetcher {
	const calls: string[] = [];
	return {
		calls,
		fetchJson: (path: string): Promise<unknown> => {
			calls.push(path);
			if (!Object.hasOwn(routes, path)) {
				return Promise.reject(new Error(`404 ${path}`));
			}
			const payload = routes[path];
			if (payload instanceof Error) return Promise.reject(payload);
			return Promise.resolve(payload);
		},
	};
}

/** A clock the test moves by hand. Epoch seconds, like the client expects. */
export function fakeClock(start = 1_000_000): { now: () => number; advance: (s: number) => void } {
	let current = start;
	return {
		now: () => current,
		advance: (seconds: number) => {
			current += seconds;
		},
	};
}
