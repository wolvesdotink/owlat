/**
 * What the log refuses to do (spec 05 §5.1, §5.3).
 *
 * A transparency log has one unforgivable failure — two heads of the same size
 * over different roots — and the cheapest way to commit it by accident is to
 * reopen a database that no longer holds the history it signed, or to run two
 * writers over one file. Both are refusals at startup, and both are tested
 * here by doing the damage the operator would have done.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from '@owlat/ostr-core';
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

/** Fill the log with `count` leaves, publish a head over them, and close it. */
async function seal(count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await harness.log.submit(attestationFrom(observer, `subject-${i}.test`), AT);
	}
	await harness.log.publishHead(AT);
	harness.log.close();
}

/** Edit the closed database the way an operator or an attacker would. */
function withDatabase(body: (db: Database.Database) => void): void {
	const db = new Database(harness.dbPath);
	try {
		body(db);
	} finally {
		db.close();
	}
}

describe('reopening a damaged database', () => {
	it('refuses when an index is missing in the middle', async () => {
		await seal(3);
		withDatabase((db) => db.prepare('DELETE FROM entries WHERE idx = 1').run());

		expect(() => harness.reopen()).toThrow(/not contiguous/);
	});

	it('refuses when the last leaf under a published head was dropped', async () => {
		await seal(4);
		withDatabase((db) => db.prepare('DELETE FROM entries WHERE idx = 3').run());

		// Indices stay dense, so only the head catches this one.
		expect(() => harness.reopen()).toThrow(/short of its published head/);
	});

	it('refuses when a stored leaf was edited in place', async () => {
		await seal(4);
		const replacement = canonicalBytes(attestationFrom(observer, 'swapped.test')).toString('utf8');
		withDatabase((db) =>
			db.prepare('UPDATE entries SET canonical = ? WHERE idx = 2').run(replacement)
		);

		expect(() => harness.reopen()).toThrow(/contradicts its published head/);
	});

	it('refuses when a head row disagrees with the head it stores', async () => {
		await seal(4);
		withDatabase((db) => db.prepare('UPDATE heads SET tree_size = 9').run());

		// The column is an index for the lookup; the signed JSON is the evidence.
		// If they disagree, one of them was edited and neither can be trusted.
		expect(() => harness.reopen()).toThrow(/malformed head/);
	});

	it('opens a truncated log that no head ever covered', async () => {
		for (let i = 0; i < 3; i++) {
			await harness.log.submit(attestationFrom(observer, `subject-${i}.test`), AT);
		}
		harness.log.close();
		withDatabase((db) => db.prepare('DELETE FROM entries WHERE idx = 2').run());

		// Nothing was ever promised about these leaves, so nothing is contradicted.
		expect(await harness.reopen().size()).toBe(2);
	});

	it('leaves the writer lock free after refusing', async () => {
		await seal(3);
		withDatabase((db) => db.prepare('DELETE FROM entries WHERE idx = 1').run());
		expect(() => harness.reopen()).toThrow(/not contiguous/);

		withDatabase((db) =>
			db
				.prepare(
					`INSERT INTO entries (idx, logged_at, canonical, leaf_hash, observer, kind)
					 SELECT 1, logged_at, canonical || ' ', leaf_hash, observer, kind FROM entries WHERE idx = 0`
				)
				.run()
		);
		// A repaired file must be openable: the failed open must not have kept
		// the lock, or the operator's next start would fail for a second reason.
		expect(() => harness.reopen()).toThrow(/contradicts its published head/);
	});
});

describe('single writer', () => {
	it('refuses a second writer over the same file', async () => {
		await harness.log.submit(attestationFrom(observer, 'example.com'), AT);

		expect(() => harness.openAnother()).toThrow(/exactly one writer/);
	});

	it('lets the next writer in once the first has closed', async () => {
		await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		expect(await harness.reopen().size()).toBe(1);
	});

	it('keeps the log readable while the writer holds the lock', async () => {
		await harness.log.submit(attestationFrom(observer, 'example.com'), AT);

		const reader = new Database(harness.dbPath, { readonly: true });
		try {
			expect(reader.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(1);
		} finally {
			reader.close();
		}
	});
});

describe('schema version', () => {
	it('records the version it wrote', async () => {
		await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		harness.log.close();

		withDatabase((db) => {
			const value = db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get('schemaVersion');
			expect(value).toBe('1');
		});
	});

	it('refuses a database written by a newer build, without downgrading it', async () => {
		await harness.log.submit(attestationFrom(observer, 'example.com'), AT);
		harness.log.close();
		withDatabase((db) =>
			db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', '2')").run()
		);

		expect(() => harness.reopen()).toThrow(/schema version 2/);
		withDatabase((db) => {
			const value = db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get('schemaVersion');
			expect(value).toBe('2');
		});
	});

	it('refuses a database whose recorded version is not a version', async () => {
		harness.log.close();
		withDatabase((db) =>
			db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', 'zwei')").run()
		);

		expect(() => harness.reopen()).toThrow(/unreadable schema version/);
	});
});
