import { describe, it, expect, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import {
	createSuggestReplies,
	decodeStreamedReplies,
	type SuggestStreamSnapshot,
} from '../useSuggestReplies';
import type { Id } from '@owlat/api/dataModel';

/**
 * Streamed suggested replies (plan 2.12): options show while the action is
 * still running, the one being written is not pickable yet, the final list
 * replaces the stream, and a missing buffer or failed action fails soft.
 */

const MESSAGE = 'msg-1' as Id<'mailMessages'>;

function harness(opts: { createFails?: boolean } = {}) {
	const snapshot = ref<SuggestStreamSnapshot | null>(null);
	let activeId: string | null = null;
	let resolveRun!: (v: string[] | null) => void;
	const deps = {
		createStream: vi.fn(async () => {
			if (opts.createFails) throw new Error('no buffer');
			return 'stream-1';
		}),
		runSuggest: vi.fn(
			(_args: unknown) =>
				new Promise<string[] | null>((res) => {
					resolveRun = res;
				})
		),
		deleteStream: vi.fn(async (_id: string) => {}),
		snapshot,
		setActiveStreamId: vi.fn((id: string | null) => {
			activeId = id;
		}),
	};
	const push = (replies: string[], status: SuggestStreamSnapshot['status'] = 'streaming') => {
		snapshot.value = { status, text: JSON.stringify(replies) };
	};
	return {
		deps,
		push,
		activeId: () => activeId,
		resolveRun: async (v: string[] | null) => {
			resolveRun(v);
			await flush();
		},
	};
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await nextTick();
}

describe('decodeStreamedReplies', () => {
	it('reads a JSON array of strings and nothing else', () => {
		expect(decodeStreamedReplies('["a","b"]')).toEqual(['a', 'b']);
		expect(decodeStreamedReplies('["a",3,""]')).toEqual(['a']);
		expect(decodeStreamedReplies('{"a":1}')).toEqual([]);
		expect(decodeStreamedReplies('["a", "unterminated')).toEqual([]);
		expect(decodeStreamedReplies('')).toEqual([]);
		expect(decodeStreamedReplies(undefined)).toEqual([]);
	});
});

describe('createSuggestReplies', () => {
	it('shows options while they stream, with only the finished ones pickable', async () => {
		const h = harness();
		const s = createSuggestReplies(h.deps);
		const done = s.run({ messageId: MESSAGE });
		await flush();

		expect(s.busy.value).toBe(true);
		expect(h.activeId()).toBe('stream-1');
		expect(h.deps.runSuggest).toHaveBeenCalledWith({ messageId: MESSAGE, streamId: 'stream-1' });

		h.push(['Sure, Tuesday']);
		expect(s.replies.value).toEqual(['Sure, Tuesday']);
		expect(s.readyCount.value).toBe(0);

		h.push(['Sure, Tuesday works.', 'How about']);
		expect(s.replies.value).toEqual(['Sure, Tuesday works.', 'How about']);
		expect(s.readyCount.value).toBe(1);

		await h.resolveRun(['Sure, Tuesday works.', 'How about Thursday?']);
		await expect(done).resolves.toEqual(['Sure, Tuesday works.', 'How about Thursday?']);
		expect(s.busy.value).toBe(false);
		expect(s.replies.value).toEqual(['Sure, Tuesday works.', 'How about Thursday?']);
		expect(s.readyCount.value).toBe(2);
		expect(h.activeId()).toBeNull();
		expect(h.deps.deleteStream).toHaveBeenCalledWith('stream-1');
	});

	it('runs without a buffer when one cannot be created', async () => {
		const h = harness({ createFails: true });
		const s = createSuggestReplies(h.deps);
		const done = s.run({ messageId: MESSAGE, focus: 'scheduling', proposedTimes: ['Tue'] });
		await flush();
		expect(h.deps.runSuggest).toHaveBeenCalledWith({
			messageId: MESSAGE,
			focus: 'scheduling',
			proposedTimes: ['Tue'],
		});
		await h.resolveRun(['Tuesday works.']);
		await expect(done).resolves.toEqual(['Tuesday works.']);
		expect(h.deps.deleteStream).not.toHaveBeenCalled();
	});

	it('fails soft: a failed action leaves no options', async () => {
		const h = harness();
		const s = createSuggestReplies(h.deps);
		const done = s.run({ messageId: MESSAGE });
		await flush();
		h.push(['Half an opt']);
		await h.resolveRun(null);
		await expect(done).resolves.toEqual([]);
		expect(s.replies.value).toEqual([]);
		expect(s.busy.value).toBe(false);
		expect(h.deps.deleteStream).toHaveBeenCalledWith('stream-1');
	});

	it('first() resolves once the first option is final, before the run ends', async () => {
		const h = harness();
		const s = createSuggestReplies(h.deps);
		let picked: string | undefined;
		void s.first({ messageId: MESSAGE }).then((text) => {
			picked = text;
		});
		await flush();

		h.push(['On it — will send']);
		await flush();
		expect(picked).toBeUndefined();

		h.push(['On it — will send today.', 'Can']);
		await flush();
		expect(picked).toBe('On it — will send today.');
		// The run is still going; it cleans up its own buffer when it ends.
		expect(h.deps.deleteStream).not.toHaveBeenCalled();
		await h.resolveRun(['On it — will send today.', 'Can it wait?']);
		expect(h.deps.deleteStream).toHaveBeenCalledWith('stream-1');
	});

	it('first() falls back to the final list, and to empty on failure', async () => {
		const h = harness();
		const s = createSuggestReplies(h.deps);
		const one = s.first({ messageId: MESSAGE });
		await flush();
		await h.resolveRun(['Only one.']);
		await expect(one).resolves.toBe('Only one.');

		const none = s.first({ messageId: MESSAGE });
		await flush();
		await h.resolveRun(null);
		await expect(none).resolves.toBe('');
	});

	it('clear() drops the options and ignores the superseded run', async () => {
		const h = harness();
		const s = createSuggestReplies(h.deps);
		void s.run({ messageId: MESSAGE });
		await flush();
		h.push(['For the old thread']);
		s.clear();
		expect(s.replies.value).toEqual([]);
		expect(s.busy.value).toBe(false);
		expect(h.activeId()).toBeNull();

		await h.resolveRun(['For the old thread.']);
		expect(s.replies.value).toEqual([]);
		// Its buffer is still cleaned up.
		expect(h.deps.deleteStream).toHaveBeenCalledWith('stream-1');
	});
});
