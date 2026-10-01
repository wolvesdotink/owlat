import { describe, expect, it } from 'vitest';
import { SequenceGate, type SequenceLease } from '../sequenceGate.js';

/** Settle every pending promise callback. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function granted(lease: SequenceLease) {
	let done = false;
	void lease.ready.then(() => {
		done = true;
	});
	return () => done;
}

describe('SequenceGate', () => {
	it('grants shared leases side by side, and a sync lease beside them', async () => {
		const gate = new SequenceGate();
		const a = granted(gate.acquire('shared'));
		const b = granted(gate.acquire('shared'));
		const sync = gate.acquire('sync');
		const c = granted(sync);
		await flush();
		expect([a(), b(), c()]).toEqual([true, true, true]);
	});

	it('holds exclusive() until every shared lease before it is released', async () => {
		const gate = new SequenceGate();
		const first = gate.acquire('shared');
		const second = gate.acquire('shared');
		const sync = gate.acquire('sync');
		await sync.ready;
		let alone = false;
		void sync.exclusive().then(() => {
			alone = true;
		});
		first.release();
		await flush();
		expect(alone).toBe(false);
		second.release();
		await flush();
		expect(alone).toBe(true);
	});

	it('keeps every lease after a sync lease waiting, in order, until it releases or downgrades', async () => {
		const gate = new SequenceGate();
		const sync = gate.acquire('sync');
		const shared = granted(gate.acquire('shared'));
		const nextSync = gate.acquire('sync');
		const next = granted(nextSync);
		await flush();
		expect([shared(), next()]).toEqual([false, false]);

		sync.downgrade();
		await flush();
		// The shared lease joins; the next sync lease is granted too, but its
		// exclusive turn waits for both shared leases.
		expect([shared(), next()]).toEqual([true, true]);
		let alone = false;
		void nextSync.exclusive().then(() => {
			alone = true;
		});
		sync.release();
		await flush();
		expect(alone).toBe(false);
	});

	it('withdraws a lease released before it was granted', async () => {
		const gate = new SequenceGate();
		const sync = gate.acquire('sync');
		const withdrawn = gate.acquire('sync');
		const after = granted(gate.acquire('sync'));
		withdrawn.release();
		withdrawn.release();
		sync.release();
		await flush();
		expect(after()).toBe(true);
	});
});
