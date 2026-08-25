/**
 * The refusals and the bounds — what a refresh will not do.
 *
 * A signed snapshot is an assertion about its own inputs: it names the head it
 * covers and the instant it was evaluated at. Every case here is a way those
 * two could stop describing the scored set — a short read, an `asOf` behind the
 * head, evidence the policy never admitted — and the aggregator has to fail
 * loudly rather than publish a signed artifact that misrepresents itself.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '@owlat/ostr-core';
import type { SequencedAttestation } from '@owlat/ostr-core';
import { MaterializedScoreIndex, type AggregatorLogger } from '../scoreIndex.js';
import type { RegistryLog } from '../../contracts.js';
import { FakeLog, LOG_ID } from './fakeLog.js';
import {
	AS_OF,
	corpus,
	newcomerEntries,
	OBSERVERS,
	retractionEntry,
	type PendingEntry,
} from './fixtures.js';

const ZONE = { origin: 'ostr.example', refBaseUrl: 'https://ostr.example/s' };

/** A log that answers like `inner` except where a test says otherwise. */
class DelegatingLog implements RegistryLog {
	readonly #inner: FakeLog;
	readonly #over: Partial<Pick<RegistryLog, 'entries' | 'entry'>>;

	constructor(inner: FakeLog, over: Partial<Pick<RegistryLog, 'entries' | 'entry'>>) {
		this.#inner = inner;
		this.#over = over;
	}

	submit(): ReturnType<RegistryLog['submit']> {
		return this.#inner.submit();
	}

	size(): Promise<number> {
		return this.#inner.size();
	}

	head(): ReturnType<RegistryLog['head']> {
		return this.#inner.head();
	}

	publishHead(timestamp: string): ReturnType<RegistryLog['publishHead']> {
		return this.#inner.publishHead(timestamp);
	}

	entries(start: number, count: number): Promise<SequencedAttestation[]> {
		return (this.#over.entries ?? this.#inner.entries.bind(this.#inner))(start, count);
	}

	entry(index: number): Promise<SequencedAttestation | null> {
		return (this.#over.entry ?? this.#inner.entry.bind(this.#inner))(index);
	}

	inclusionProof(index: number, treeSize: number): Promise<string[]> {
		return this.#inner.inclusionProof(index, treeSize);
	}

	consistencyProof(oldSize: number, newSize: number): Promise<string[]> {
		return this.#inner.consistencyProof(oldSize, newSize);
	}
}

/** A logger that keeps what it was told, so a warning is assertable. */
function recordingLogger(): AggregatorLogger & {
	warnings: { fields: unknown; message: string }[];
} {
	const warnings: { fields: unknown; message: string }[] = [];
	return { warnings, warn: (fields, message) => warnings.push({ fields, message }) };
}

let dir: string;
let log: FakeLog;
let index: MaterializedScoreIndex | null = null;

function open(over: { log?: RegistryLog; logger?: AggregatorLogger; budget?: number } = {}) {
	const built = new MaterializedScoreIndex({
		dbPath: join(dir, 'aggregator.db'),
		log: over.log ?? log,
		aggregatorPrivateKeyBase64: generateEd25519KeyPair().privateKey,
		zone: ZONE,
		...(over.logger === undefined ? {} : { logger: over.logger }),
		...(over.budget === undefined ? {} : { refreshWorkBudget: over.budget }),
	});
	index = built;
	return built;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ostr-guards-'));
	log = new FakeLog(generateEd25519KeyPair().privateKey);
});

afterEach(() => {
	index?.close();
	index = null;
	rmSync(dir, { recursive: true, force: true });
});

describe('refresh: the as-of instant', () => {
	it('rejects an asOf that is not an RFC 3339 UTC instant', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);

		await expect(open().refresh('yesterday')).rejects.toThrow(/RFC 3339/);
	});

	it('rejects an asOf earlier than the head it would declare', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);

		// The head says "these leaves"; an earlier `asOf` makes the policy say
		// "not yet visible" about the same leaves, and the snapshot would
		// declare coverage its own numbers contradict.
		await expect(open().refresh('2026-08-19T00:00:00Z')).rejects.toThrow(/precedes the timestamp/);
	});

	it('accepts a later asOf, and publishes the head timestamp rather than it', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
		const later = '2026-08-20T01:00:00Z';
		const built = open();

		await built.refresh(later);

		// Spec 08 §8.1: `asof` is the declared head's timestamp. The evaluation
		// instant is an hour later, and advertising it would overstate coverage.
		const zone = await built.dnsZone();
		expect(zone).toContain(`asof=${AS_OF};`);
		expect(zone).not.toContain(`asof=${later}`);
		expect((await built.snapshot())?.asOf).toBe(later);
	});
});

describe('refresh: the log it reads', () => {
	it('refuses to sign a snapshot over a short read', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
		// A truncated, rebuilt or half-restored log: it answers with a prefix of
		// what its own head claims to cover.
		const truncated = new DelegatingLog(log, {
			entries: (start, count) =>
				start >= 3 ? Promise.resolve([]) : log.entries(start, Math.min(count, 3 - start)),
		});

		await expect(open({ log: truncated }).refresh(AS_OF)).rejects.toThrow(
			/the declared head covers/
		);
	});

	it('refreshes an empty log with no published head at all', async () => {
		const built = open();

		expect(await built.refresh(AS_OF)).toEqual({ subjects: 0, asOf: AS_OF });
		expect((await built.snapshot())?.heads).toEqual([]);
		expect(await built.dnsZone()).toContain('$ORIGIN ostr.example.');
		expect(await built.diffSince(0)).toEqual([]);
	});

	it('warns when a refresh exceeds its work budget', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
		const logger = recordingLogger();

		await open({ logger, budget: 1 }).refresh(AS_OF);

		expect(logger.warnings).toHaveLength(1);
		expect(logger.warnings[0]?.message).toMatch(/work budget/);
		expect(logger.warnings[0]?.fields).toMatchObject({ budget: 1 });
	});

	it('stays quiet inside its budget', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
		const logger = recordingLogger();

		await open({ logger }).refresh(AS_OF);

		expect(logger.warnings).toEqual([]);
	});
});

describe('evidence: what actually fed the score', () => {
	it('drops an attestation its own observer retracted', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
		const built = open();
		await built.refresh(AS_OF);
		const before = await built.evidence({ domain: 'veteran.example' }, 0, 100);
		const target = before.find(
			(entry) => entry.attestation.observer === OBSERVERS[0]
		) as SequencedAttestation;

		log.append([
			retractionEntry({
				observer: OBSERVERS[0],
				subject: { domain: 'veteran.example' },
				supersedes: { logId: LOG_ID, index: target.index },
			}),
		]);
		await log.publishHead(AS_OF);
		await built.refresh(AS_OF);

		const after = await built.evidence({ domain: 'veteran.example' }, 0, 100);
		expect(after.map((entry) => entry.index)).not.toContain(target.index);
		expect(after.length).toBeGreaterThan(0);
	});

	it('does not mint a subject out of an entry the policy cannot see', async () => {
		log.append(corpus());
		// Covered by the head, but logged after the evaluation instant, so the
		// policy admits nothing for it. Discovery still names the subject; it
		// must not reach a published surface with a number derived from nothing
		// (spec 08 §8.1 — this aggregator answers NXDOMAIN).
		const pending = newcomerEntries()[0] as PendingEntry;
		log.append([{ loggedAt: '2026-08-21T00:00:00Z', attestation: pending.attestation }]);
		await log.publishHead(AS_OF);
		const built = open();

		await built.refresh(AS_OF);
		expect(await built.score({ domain: 'newcomer.example' })).toBeNull();
		expect(await built.evidence({ domain: 'newcomer.example' }, 0, 10)).toEqual([]);

		// Once the entry is visible, the subject appears.
		await built.refresh('2026-08-21T00:00:00Z');
		expect(await built.score({ domain: 'newcomer.example' })).not.toBeNull();
	});

	it('skips an evidence pointer whose log entry has gone', async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
		// A rebuilt log: the materialized pointer no longer resolves.
		const holed = new DelegatingLog(log, {
			entry: (at) => (at % 2 === 0 ? Promise.resolve(null) : log.entry(at)),
		});
		const built = open({ log: holed });
		await built.refresh(AS_OF);

		const evidence = await built.evidence({ domain: 'veteran.example' }, 0, 100);
		expect(evidence.length).toBeGreaterThan(0);
		expect(evidence.every((entry) => entry.index % 2 === 1)).toBe(true);
	});
});

describe('read paths: bounds', () => {
	beforeEach(async () => {
		log.append(corpus());
		await log.publishHead(AS_OF);
	});

	it('clamps a negative or absurd page', async () => {
		const built = open();
		await built.refresh(AS_OF);

		expect(await built.evidence({ domain: 'veteran.example' }, -5, 0)).toEqual([]);
		const capped = await built.evidence({ domain: 'veteran.example' }, -5, 10_000);
		const paged = await built.evidence({ domain: 'veteran.example' }, 0, 100);
		expect(capped.map((entry) => entry.index)).toEqual(paged.map((entry) => entry.index));
		expect(await built.evidence({ domain: 'veteran.example' }, 1.9, 1)).toHaveLength(1);
	});

	it('treats a negative diff cursor as the start of the feed', async () => {
		const built = open();
		await built.refresh(AS_OF);

		expect(await built.diffSince(-3)).toEqual(await built.diffSince(0));
	});
});
