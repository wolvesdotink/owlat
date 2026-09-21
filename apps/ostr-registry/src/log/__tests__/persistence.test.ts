/**
 * Durability across a restart. Nothing derived is stored: the tree is rebuilt
 * from the leaves on open, so a reopened log must produce the same root, the
 * same proofs and the same indices — and must still refuse to re-append a leaf
 * it already holds.
 *
 * What a reopen refuses to do with a damaged file is in `integrity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalBytes, parseHash, verifyInclusion } from '@owlat/ostr-core';
import Database from 'better-sqlite3';
import {
	attestationFrom,
	type LogHarness,
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

describe('reopening the database', () => {
	it('rebuilds the same tree from the stored leaves', async () => {
		for (let i = 0; i < 6; i++) {
			await harness.log.submit(attestationFrom(observer, `subject-${i}.test`), AT);
		}
		const before = await harness.log.publishHead(AT);

		const reopened = harness.reopen();
		expect(await reopened.size()).toBe(6);
		const after = await reopened.publishHead(AT);
		expect(after.rootHash).toBe(before.rootHash);
		expect(after.sig).toBe(before.sig);
	});

	it('keeps serving the head published before the restart', async () => {
		await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		const published = await harness.log.publishHead(AT);

		const reopened = harness.reopen();
		expect(await reopened.head()).toEqual(published);
	});

	it('continues sequencing where it left off', async () => {
		await harness.log.submit(attestationFrom(observer, 'first.test'), AT);
		const reopened = harness.reopen();
		const outcome = await reopened.submit(attestationFrom(observer, 'second.test'), AT);
		expect(outcome).toMatchObject({ accepted: true, index: 1, duplicate: false });
	});

	it('still dedupes a leaf stored by the previous process', async () => {
		const attestation = attestationFrom(observer, 'example.com');
		await harness.log.submit(attestation, AT);

		const reopened = harness.reopen();
		const again = await reopened.submit(attestation, '2026-08-21T10:00:00Z');
		expect(again).toMatchObject({ accepted: true, index: 0, duplicate: true });
		expect(await reopened.size()).toBe(1);
	});

	it('serves proofs that verify against a pre-restart head', async () => {
		const leaves: Buffer[] = [];
		for (let i = 0; i < 5; i++) {
			const attestation = attestationFrom(observer, `subject-${i}.test`);
			await harness.log.submit(attestation, AT);
			leaves.push(canonicalBytes(attestation));
		}
		const head = await harness.log.publishHead(AT);
		const root = parseHash(head.rootHash);
		if (root === undefined) throw new Error('malformed root hash');

		const reopened = harness.reopen();
		const proof = await reopened.inclusionProof(3, head.treeSize);
		expect(
			verifyInclusion({
				leaf: leaves[3] as Buffer,
				index: 3,
				treeSize: head.treeSize,
				proof: proof.map((hash) => {
					const parsed = parseHash(hash);
					if (parsed === undefined) throw new Error('malformed proof element');
					return parsed;
				}),
				root,
			})
		).toBe(true);
	});

	it('starts empty on a fresh database file', async () => {
		expect(await harness.log.size()).toBe(0);
		expect(await harness.log.head()).toBeNull();
		expect(await harness.log.entries(0, 10)).toEqual([]);
	});
});

describe('stored rows', () => {
	it('records the leaf, its hash and the read-side subject columns', async () => {
		const attestation = attestationFrom(observer, 'example.com');
		await harness.log.submit(attestation, AT);
		harness.reopen();

		const db = new Database(harness.dbPath, { readonly: true });
		try {
			const row = db.prepare('SELECT * FROM entries WHERE idx = 0').get() as Record<
				string,
				unknown
			>;
			expect(row['canonical']).toBe(canonicalBytes(attestation).toString('utf8'));
			expect(row['logged_at']).toBe(AT);
			expect(row['observer']).toBe('mx.observer.test');
			expect(row['kind']).toBe('traffic-summary');
			expect(row['subject_domain']).toBe('example.com');
			expect(row['subject_ip']).toBeNull();
			expect((row['leaf_hash'] as Buffer).length).toBe(32);
			expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
		} finally {
			db.close();
		}
	});

	it('refuses a second row for the same canonical bytes', async () => {
		const attestation = attestationFrom(observer, 'example.com');
		await harness.log.submit(attestation, AT);
		harness.reopen();

		const db = new Database(harness.dbPath);
		try {
			const canonical = canonicalBytes(attestation).toString('utf8');
			expect(() =>
				db
					.prepare(
						`INSERT INTO entries
							(idx, logged_at, canonical, leaf_hash, observer, kind, subject_domain, subject_ip)
						 VALUES (1, ?, ?, x'00', 'mx.observer.test', 'traffic-summary', 'example.com', NULL)`
					)
					.run(AT, canonical)
			).toThrow(/UNIQUE/);
		} finally {
			db.close();
		}
	});
});
