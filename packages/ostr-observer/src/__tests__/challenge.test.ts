import { describe, expect, it } from 'vitest';
import { parseHash, sha256, verifyBundleOpening } from '@owlat/ostr-core';
import {
	answerChallenge,
	MemoryBatchCommitmentStore,
	retainBatchCommitment,
} from '../challenge.js';
import { buildSpamReportBatch, type SpamReportEntry } from '../spamBatch.js';

const WINDOW = { from: '2026-08-19T00:00:00Z', to: '2026-08-20T00:00:00Z' };
const SUBJECT = { domain: 'example.com' };

function bundles(count: number): SpamReportEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		bundleHash: sha256(`bundle-${index}`).toString('hex'),
		signingDomain: 'example.com',
		reporter: `reporter-${index}`,
	}));
}

function published(count = 8) {
	const batch = buildSpamReportBatch({ subject: SUBJECT, window: WINDOW, bundles: bundles(count) });
	if (!batch.ok) throw new Error(`expected a batch: ${batch.reason}`);
	const store = new MemoryBatchCommitmentStore();
	retainBatchCommitment(store, batch.draft, batch.bundleHashes);
	return { batch, store };
}

describe('answering a challenge (§7.2.4)', () => {
	it('opens the sampled indices against the published commitment', () => {
		const { batch, store } = published();
		const answer = answerChallenge(store.get(SUBJECT, WINDOW), [0, 3, 7]);
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.openings.map((opening) => opening.index)).toEqual([0, 3, 7]);
		expect(answer.commitmentHex).toBe(batch.draft.body.commitment);

		for (const opening of answer.openings) {
			expect(
				verifyBundleOpening({
					// The size comes from the SIGNED attestation, never from the answer.
					committedSize: batch.draft.body.reports,
					root: parseHash(batch.draft.body.commitment) as Buffer,
					index: opening.index,
					treeSize: opening.treeSize,
					bundleHash: parseHash(opening.bundleHash) as Buffer,
					proof: opening.proof.map((node) => parseHash(node) as Buffer),
				})
			).toBe(true);
		}
	});

	it('survives a JSON round-trip, which is how it reaches a monitor', () => {
		const { batch, store } = published();
		const answer = answerChallenge(store.get(SUBJECT, WINDOW), [5]);
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		const [opening] = JSON.parse(JSON.stringify(answer.openings)) as typeof answer.openings;
		expect(opening).toBeDefined();
		if (opening === undefined) return;
		expect(
			verifyBundleOpening({
				committedSize: batch.draft.body.reports,
				root: parseHash(batch.draft.body.commitment) as Buffer,
				index: opening.index,
				treeSize: opening.treeSize,
				bundleHash: parseHash(opening.bundleHash) as Buffer,
				proof: opening.proof.map((node) => parseHash(node) as Buffer),
			})
		).toBe(true);
	});

	it('refuses a batch it never retained, or one past retention', () => {
		const { store } = published();
		expect(answerChallenge(store.get({ domain: 'other.example' }, WINDOW), [0])).toEqual({
			ok: false,
			reason: 'unknown-batch',
		});
		expect(store.prune('2026-11-19T00:00:00Z')).toBe(1);
		expect(answerChallenge(store.get(SUBJECT, WINDOW), [0])).toEqual({
			ok: false,
			reason: 'unknown-batch',
		});
	});

	it('keeps a batch inside the retention window', () => {
		const { store } = published();
		expect(store.prune('2026-08-19T00:00:00Z')).toBe(0);
		expect(store.size).toBe(1);
	});

	it('refuses indices outside the committed batch', () => {
		const { store } = published(4);
		const record = store.get(SUBJECT, WINDOW);
		expect(answerChallenge(record, [])).toEqual({ ok: false, reason: 'invalid-indices' });
		expect(answerChallenge(record, [4])).toEqual({ ok: false, reason: 'invalid-indices' });
		expect(answerChallenge(record, [-1])).toEqual({ ok: false, reason: 'invalid-indices' });
		expect(answerChallenge(record, [1.5])).toEqual({ ok: false, reason: 'invalid-indices' });
	});

	it('refuses to answer from a list that no longer reproduces the root', () => {
		const { store } = published(4);
		const record = store.get(SUBJECT, WINDOW);
		expect(record).not.toBeNull();
		if (record === null) return;
		// A store that reordered the list would produce proofs against a root the
		// observer never published — worse than not answering at all.
		record.bundleHashes.reverse();
		expect(answerChallenge(record, [0])).toEqual({ ok: false, reason: 'commitment-mismatch' });

		record.bundleHashes = ['not-a-hash'];
		expect(answerChallenge(record, [0])).toEqual({ ok: false, reason: 'commitment-mismatch' });
	});

	it('refuses to retain a batch draft with no window to file it under', () => {
		const { batch } = published(4);
		const store = new MemoryBatchCommitmentStore();
		expect(() =>
			retainBatchCommitment(store, { ...batch.draft, window: undefined }, batch.bundleHashes)
		).toThrow(RangeError);
	});
});
