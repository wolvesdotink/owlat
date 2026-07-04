import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import {
	useDraftRevise,
	isReviseEligible,
	type ReviseStreamSnapshot,
	type ReviseResult,
} from '../useDraftRevise';

/** Deferred runRevise the test resolves by hand, plus a controllable snapshot. */
function harness() {
	const snapshot = ref<ReviseStreamSnapshot | null>(null);
	let activeId: string | null = null;
	let resolve!: (v: ReviseResult) => void;
	let reject!: (e: unknown) => void;
	const deps = {
		createStream: vi.fn(async () => 'stream-1'),
		runRevise: vi.fn(
			(_id: string, _input: unknown) =>
				new Promise<ReviseResult>((res, rej) => {
					resolve = res;
					reject = rej;
				}),
		),
		deleteStream: vi.fn(async () => {}),
		snapshot,
		setActiveStreamId: vi.fn((id: string | null) => {
			activeId = id;
		}),
		onError: vi.fn(),
	};
	return {
		deps,
		snapshot,
		activeId: () => activeId,
		resolveWith: async (v: ReviseResult) => {
			resolve(v);
			await Promise.resolve();
			await Promise.resolve();
		},
		rejectWith: async (e: unknown) => {
			reject(e);
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe('isReviseEligible', () => {
	it('requires AI on and a non-empty draft', () => {
		expect(isReviseEligible(true, 'a draft')).toBe(true);
		expect(isReviseEligible(false, 'a draft')).toBe(false);
		expect(isReviseEligible(true, '   ')).toBe(false);
	});
});

describe('useDraftRevise lifecycle', () => {
	it('streams progressively then resolves to the revised text', async () => {
		const h = harness();
		const r = useDraftRevise(h.deps);

		const p = r.start({ instruction: 'decline politely', currentDraft: 'Sure!' });
		await Promise.resolve();
		await Promise.resolve();

		expect(r.isStreaming.value).toBe(true);
		expect(h.deps.createStream).toHaveBeenCalledOnce();
		expect(h.activeId()).toBe('stream-1');

		// Tokens arrive via the reactive buffer subscription.
		h.snapshot.value = { status: 'streaming', text: 'Thank you', injectionFlagged: false };
		expect(r.displayText.value).toBe('Thank you');
		h.snapshot.value = {
			status: 'streaming',
			text: 'Thank you, but we must decline.',
			injectionFlagged: false,
		};
		expect(r.displayText.value).toBe('Thank you, but we must decline.');

		await h.resolveWith({
			status: 'complete',
			text: 'Thank you, but we must decline.',
			injectionFlagged: false,
		});
		await p;

		expect(r.status.value).toBe('done');
		expect(r.hasResult.value).toBe(true);
		expect(r.displayText.value).toBe('Thank you, but we must decline.');
	});

	it('does not start on an empty instruction', async () => {
		const h = harness();
		const r = useDraftRevise(h.deps);
		await r.start({ instruction: '   ', currentDraft: 'Sure!' });
		expect(r.status.value).toBe('idle');
		expect(h.deps.createStream).not.toHaveBeenCalled();
	});

	it('apply returns the revised text and deletes the buffer', async () => {
		const h = harness();
		const r = useDraftRevise(h.deps);
		const p = r.start({ instruction: 'shorter', currentDraft: 'A long draft.' });
		await Promise.resolve();
		await h.resolveWith({ status: 'complete', text: 'Short.', injectionFlagged: false });
		await p;

		const applied = await r.apply();
		expect(applied).toBe('Short.');
		expect(h.deps.deleteStream).toHaveBeenCalledWith('stream-1');
		expect(r.status.value).toBe('idle');
		expect(h.activeId()).toBe(null);
	});

	it('surfaces an advisory injection flag from the final result', async () => {
		const h = harness();
		const r = useDraftRevise(h.deps);
		const p = r.start({ instruction: 'x', currentDraft: 'y' });
		await Promise.resolve();
		await h.resolveWith({ status: 'complete', text: 'poisoned', injectionFlagged: true });
		await p;
		expect(r.injectionFlagged.value).toBe(true);
	});

	it('fails soft on a backend error status: onError fires, draft untouched', async () => {
		const h = harness();
		const r = useDraftRevise(h.deps);
		const p = r.start({ instruction: 'x', currentDraft: 'y' });
		await Promise.resolve();
		await h.resolveWith({ status: 'error', text: '', injectionFlagged: false });
		await p;
		expect(r.status.value).toBe('error');
		expect(h.deps.onError).toHaveBeenCalled();
		expect(h.deps.deleteStream).toHaveBeenCalled();
	});

	it('fails soft on a thrown error', async () => {
		const h = harness();
		const r = useDraftRevise(h.deps);
		const p = r.start({ instruction: 'x', currentDraft: 'y' });
		await Promise.resolve();
		await h.rejectWith(new Error('network'));
		await p;
		expect(r.status.value).toBe('error');
		expect(h.deps.onError).toHaveBeenCalled();
	});
});
