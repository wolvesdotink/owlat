/**
 * Heads, proofs and entry retrieval (spec 05 §5.3, §5.4). Every proof is
 * checked the way a verifier checks it: against the root of a signed tree head
 * the log published, never against a root the log handed over alongside the
 * proof.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	canonicalBytes,
	emptyTreeRoot,
	leafHash,
	parseHash,
	toHex,
	verifyConsistency,
	verifyInclusion,
	verifyTreeHead,
} from '@owlat/ostr-core';
import Database from 'better-sqlite3';
import { MAX_ENTRIES_PAGE } from '../index.js';
import {
	attestationFrom,
	type LogHarness,
	LOG_ID,
	makeLog,
	type Observer,
	publishObserver,
} from './support.js';

const AT = '2026-08-20T10:00:00Z';

let harness: LogHarness;
let observer: Observer;

beforeEach(() => {
	harness = makeLog();
	observer = publishObserver(harness.keys, 'mx.observer.test');
});

afterEach(() => {
	harness.cleanup();
});

/**
 * Appends `count` distinct leaves starting at the log's current size and
 * returns their bytes; each subject is named after its index, so a second call
 * extends the log rather than re-submitting.
 */
async function fill(count: number): Promise<Buffer[]> {
	const first = await harness.log.size();
	const leaves: Buffer[] = [];
	for (let i = first; i < first + count; i++) {
		const attestation = attestationFrom(observer, `subject-${i}.test`);
		const outcome = await harness.log.submit(attestation, AT);
		expect(outcome).toMatchObject({ accepted: true, index: i });
		leaves.push(canonicalBytes(attestation));
	}
	return leaves;
}

function asHash(rootHash: string): Buffer {
	const root = parseHash(rootHash);
	if (root === undefined) throw new Error('head carried a malformed root hash');
	return root;
}

describe('published heads', () => {
	it('has no head before the first publication', async () => {
		expect(await harness.log.head()).toBeNull();
	});

	it('signs the empty tree', async () => {
		const head = await harness.log.publishHead(AT);
		expect(head).toMatchObject({ v: 1, type: 'sth', logId: LOG_ID, treeSize: 0 });
		expect(head.rootHash).toBe(toHex(emptyTreeRoot()));
		expect(verifyTreeHead(head, harness.logKey.publicKey)).toBe(true);
	});

	it('covers everything appended so far and serves the latest', async () => {
		await fill(3);
		const first = await harness.log.publishHead(AT);
		await fill(1);
		const second = await harness.log.publishHead('2026-08-20T11:00:00Z');

		expect(first.treeSize).toBe(3);
		expect(second.treeSize).toBe(4);
		expect(second.rootHash).not.toBe(first.rootHash);
		expect(await harness.log.head()).toEqual(second);
	});

	it('never signs two roots for one size', async () => {
		await fill(2);
		const a = await harness.log.publishHead(AT);
		const b = await harness.log.publishHead('2026-08-20T12:00:00Z');
		expect(b.rootHash).toBe(a.rootHash);
		expect(b.timestamp).not.toBe(a.timestamp);
	});

	it('rejects a head timestamp that is not a UTC instant', async () => {
		await expect(harness.log.publishHead('yesterday')).rejects.toThrow(RangeError);
	});

	it('keeps every head it ever published, in publication order', async () => {
		const published = [];
		for (let hour = 10; hour < 13; hour++) {
			await fill(1);
			published.push(await harness.log.publishHead(`2026-08-20T${hour}:00:00Z`));
		}

		// Spec 05 §5.3: retained indefinitely, so a year-old proof still has its
		// head. The oldest must still be readable, not just counted.
		expect(await harness.log.heads(0, 10)).toEqual(published);
		expect(await harness.log.heads(2, 10)).toEqual([published[2]]);
		expect(await harness.log.headAt(1)).toEqual(published[0]);
		expect(await harness.log.headAt(3)).toEqual(published[2]);
	});

	it('serves the newest head of a size republished with nothing new', async () => {
		await fill(2);
		const first = await harness.log.publishHead(AT);
		const again = await harness.log.publishHead('2026-08-20T11:00:00Z');

		expect(await harness.log.headAt(2)).toEqual(again);
		expect(await harness.log.heads(0, 10)).toEqual([first, again]);
	});

	it('has no head at a size it never published', async () => {
		await fill(2);
		await harness.log.publishHead(AT);
		expect(await harness.log.headAt(1)).toBeNull();
		expect(await harness.log.heads(5, 10)).toEqual([]);
	});

	it('reads back every head after a restart', async () => {
		await fill(1);
		const first = await harness.log.publishHead(AT);
		await fill(1);
		const second = await harness.log.publishHead('2026-08-20T11:00:00Z');

		const reopened = harness.reopen();
		expect(await reopened.heads(0, 10)).toEqual([first, second]);
	});
});

describe('leaf hash lookup', () => {
	it('finds the index of a submitted leaf by its hash', async () => {
		const leaves = await fill(3);
		const hash = toHex(leafHash(leaves[1] as Buffer));

		// Spec 05 §5.4 asks for inclusion proofs by leaf hash: an inclusion
		// promise carries the hash and nothing else, so that is what a verifier
		// holding one can look the leaf up with.
		expect(await harness.log.indexOfLeafHash(hash)).toBe(1);
		const proof = await harness.log.inclusionProof(1, 3);
		expect(proof.length).toBeGreaterThan(0);
	});

	it('answers null for a hash the log does not hold, and for a malformed one', async () => {
		await fill(1);
		expect(await harness.log.indexOfLeafHash(toHex(leafHash(Buffer.from('elsewhere'))))).toBeNull();
		expect(await harness.log.indexOfLeafHash('not-a-hash')).toBeNull();
		expect(await harness.log.indexOfLeafHash('AB'.repeat(32))).toBeNull();
	});

	it('survives a restart, because the lookup is over the stored rows', async () => {
		const leaves = await fill(2);
		const reopened = harness.reopen();
		expect(await reopened.indexOfLeafHash(toHex(leafHash(leaves[0] as Buffer)))).toBe(0);
	});
});

describe('inclusion proofs', () => {
	it('verifies every leaf against the head root', async () => {
		const leaves = await fill(7);
		const head = await harness.log.publishHead(AT);
		const root = asHash(head.rootHash);

		for (const [index, leaf] of leaves.entries()) {
			const proof = await harness.log.inclusionProof(index, head.treeSize);
			expect(
				verifyInclusion({
					leaf,
					index,
					treeSize: head.treeSize,
					proof: proof.map((hash) => asHash(hash)),
					root,
				})
			).toBe(true);
		}
	});

	it('verifies against a historic head after the tree has grown', async () => {
		const leaves = await fill(3);
		const historic = await harness.log.publishHead(AT);
		await fill(5);

		const proof = await harness.log.inclusionProof(1, historic.treeSize);
		expect(
			verifyInclusion({
				leaf: leaves[1] as Buffer,
				index: 1,
				treeSize: historic.treeSize,
				proof: proof.map((hash) => asHash(hash)),
				root: asHash(historic.rootHash),
			})
		).toBe(true);
	});

	it('is empty for the single-leaf tree, whose leaf hash is the root', async () => {
		await fill(1);
		expect(await harness.log.inclusionProof(0, 1)).toEqual([]);
	});

	it('does not verify a leaf that is not at the claimed index', async () => {
		const leaves = await fill(4);
		const head = await harness.log.publishHead(AT);
		const proof = await harness.log.inclusionProof(2, head.treeSize);

		expect(
			verifyInclusion({
				leaf: leaves[3] as Buffer,
				index: 2,
				treeSize: head.treeSize,
				proof: proof.map((hash) => asHash(hash)),
				root: asHash(head.rootHash),
			})
		).toBe(false);
	});

	it.each([
		['a negative index', -1, 4],
		['an index at the tree size', 4, 4],
		['a tree size beyond the log', 0, 9],
		['a fractional index', 1.5, 4],
	])('throws RangeError for %s', async (_label, index, treeSize) => {
		await fill(4);
		await expect(harness.log.inclusionProof(index, treeSize)).rejects.toThrow(RangeError);
	});
});

describe('consistency proofs', () => {
	it('verifies that the tree only grew', async () => {
		await fill(4);
		const old = await harness.log.publishHead(AT);
		await fill(5);
		const current = await harness.log.publishHead('2026-08-20T11:00:00Z');

		const proof = await harness.log.consistencyProof(old.treeSize, current.treeSize);
		expect(
			verifyConsistency({
				oldSize: old.treeSize,
				newSize: current.treeSize,
				oldRoot: asHash(old.rootHash),
				newRoot: asHash(current.rootHash),
				proof: proof.map((hash) => asHash(hash)),
			})
		).toBe(true);
	});

	it('is empty from the empty tree and between equal sizes', async () => {
		await fill(3);
		expect(await harness.log.consistencyProof(0, 3)).toEqual([]);
		expect(await harness.log.consistencyProof(3, 3)).toEqual([]);
	});

	it.each([
		['a shrinking pair', 3, 2],
		['a size beyond the log', 1, 9],
		['a negative size', -1, 3],
	])('throws RangeError for %s', async (_label, oldSize, newSize) => {
		await fill(3);
		await expect(harness.log.consistencyProof(oldSize, newSize)).rejects.toThrow(RangeError);
	});
});

describe('entry retrieval', () => {
	it('reconstructs sequenced attestations in log order', async () => {
		const attestation = attestationFrom(observer, 'example.com');
		await harness.log.submit(attestation, AT);
		await harness.log.submit(attestationFrom(observer, 'second.test'), '2026-08-20T10:05:00Z');

		const entries = await harness.log.entries(0, 10);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toEqual({
			logId: LOG_ID,
			index: 0,
			loggedAt: AT,
			attestation,
		});
		expect(entries[1]?.loggedAt).toBe('2026-08-20T10:05:00Z');
	});

	it('pages from a start with a count', async () => {
		await fill(5);
		const page = await harness.log.entries(2, 2);
		expect(page.map((entry) => entry.index)).toEqual([2, 3]);
	});

	it('answers empty at the head, so a tailing monitor can poll', async () => {
		await fill(2);
		expect(await harness.log.entries(2, 10)).toEqual([]);
		expect(await harness.log.entries(0, 0)).toEqual([]);
	});

	it('returns a single entry, and null past the end', async () => {
		await fill(2);
		expect((await harness.log.entry(1))?.index).toBe(1);
		expect(await harness.log.entry(2)).toBeNull();
	});

	it.each([
		['a negative start', -1, 1],
		['a start beyond the tree', 3, 1],
		['a negative count', 0, -1],
	])('throws RangeError for %s', async (_label, start, count) => {
		await fill(2);
		await expect(harness.log.entries(start, count)).rejects.toThrow(RangeError);
	});

	it('throws RangeError for a negative entry index', async () => {
		await expect(harness.log.entry(-1)).rejects.toThrow(RangeError);
	});

	it('clamps a page to MAX_ENTRIES_PAGE however many are asked for', async () => {
		await fill(1);
		harness.log.close();
		// Written as rows rather than submissions: what is under test is the size
		// of the answer, not its contents. Without the clamp, a caller outside the
		// HTTP layer — an import job, an operator tool — asking for 1e6 would
		// materialize the whole tree.
		const db = new Database(harness.dbPath);
		const insert = db.prepare(
			`INSERT INTO entries (idx, logged_at, canonical, leaf_hash, observer, kind)
			 VALUES (?, ?, ?, x'00', 'mx.observer.test', 'posture')`
		);
		db.transaction(() => {
			for (let i = 1; i <= MAX_ENTRIES_PAGE; i++) insert.run(i, AT, `{"i":${i}}`);
		})();
		db.close();

		const reopened = harness.reopen();
		expect(await reopened.size()).toBe(MAX_ENTRIES_PAGE + 1);
		expect(await reopened.entries(0, 1e6)).toHaveLength(MAX_ENTRIES_PAGE);
	});
});
