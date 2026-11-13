/**
 * A Team Inbox thread's messages, a page at a time: the first page and the
 * messages waiting on a person merge into one list, older pages follow the
 * cursor only when asked for, and `cover` walks back only as far as the ids it
 * is given. The fake client answers each page by its cursor and counts the
 * subscriptions opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { queryResult } from '~/__tests__/queryStubs';
import { useTeamThreadMessages } from '../team/useTeamThreadMessages';

const msg = (n: number, over: Record<string, unknown> = {}) => ({
	_id: `in_${n}`,
	_creationTime: n,
	processingStatus: 'sent',
	isBodyDeferred: true,
	...over,
});

/** A thread of `size` messages served in pages of `pageSize`, newest page first. */
function pagesOf(size: number, pageSize: number) {
	const byCursor = new Map<string, unknown>();
	for (let end = size, i = 0; end > 0; end -= pageSize, i++) {
		const start = Math.max(0, end - pageSize);
		byCursor.set(i === 0 ? '' : `c${i}`, {
			head:
				i === 0
					? {
							thread: { _id: 'ct_1' },
							contact: null,
							takeOver: { messages: [] },
							waiting: [msg(0, { processingStatus: 'draft_ready' })],
						}
					: null,
			messages: Array.from({ length: end - start }, (_, k) => msg(start + k + 1)),
			cursor: `c${i + 1}`,
			isDone: start === 0,
		});
	}
	return byCursor;
}

let scope: EffectScope;
let opened: string[];

function mountWith(byCursor: Map<string, unknown>) {
	opened = [];
	vi.stubGlobal('useConvexQuery', (_q: unknown, args: () => { cursor?: string }) => {
		const cursor = args().cursor ?? '';
		opened.push(cursor);
		return queryResult(byCursor.get(cursor));
	});
	scope = effectScope();
	return scope.run(() =>
		useTeamThreadMessages(ref('ct_1' as Id<'conversationThreads'>), { withBodies: false })
	)!;
}

beforeEach(() => {
	opened = [];
});
afterEach(() => {
	scope.stop();
});

describe('useTeamThreadMessages', () => {
	it('opens one page for a 1000-message thread, with the waiting draft from further back', () => {
		const page = mountWith(pagesOf(1000, 20));

		expect(opened).toEqual(['']);
		expect(page.messages.value).toHaveLength(21);
		expect(page.messages.value[0]?._id).toBe('in_0');
		expect(page.messages.value.at(-1)?._id).toBe('in_1000');
		expect(page.hasEarlier.value).toBe(true);
	});

	it('walks the cursor back page by page, each message once, oldest first', async () => {
		const page = mountWith(pagesOf(100, 20));
		// 100 messages in pages of 20: four older pages after the first.
		for (const _ of [1, 2, 3, 4]) {
			expect(page.hasEarlier.value).toBe(true);
			page.loadEarlier();
			await nextTick();
		}

		expect(page.hasEarlier.value).toBe(false);
		expect(opened).toEqual(['', 'c1', 'c2', 'c3', 'c4']);
		expect(page.messages.value.map((m) => m._id)).toEqual(
			Array.from({ length: 101 }, (_, n) => `in_${n}`)
		);
	});

	it('covers the ids it is given, and stops there', async () => {
		const page = mountWith(pagesOf(1000, 20));
		const wanted = ref<string[]>(['in_990']);
		page.cover(() => wanted.value);
		await nextTick();
		expect(opened).toEqual(['']);

		wanted.value = ['in_950'];
		await nextTick();
		await nextTick();
		await nextTick();
		expect(opened).toEqual(['', 'c1', 'c2']);
		expect(page.messages.value.some((m) => m._id === 'in_950')).toBe(true);
	});
});
