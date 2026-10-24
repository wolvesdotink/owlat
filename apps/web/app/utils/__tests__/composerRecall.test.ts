/**
 * ↑ in an empty message box: which press counts, which chat message it opens,
 * and how the Assistant's question history steps.
 */
import { describe, expect, it } from 'vitest';

import {
	COMPOSER_RECALL_NEWER_CHORD,
	COMPOSER_RECALL_OLDER_CHORD,
	buildPromptHistory,
	caretOnFirstLine,
	caretOnLastLine,
	composerRecallDirection,
	findChatRecallTarget,
	stepPromptHistory,
	type ChatRecallMessage,
	type PromptHistoryEntry,
	type PromptHistoryPosition,
} from '../composerRecall';
import { SHORTCUT_CATALOG } from '../shortcutCatalog';

describe('composerRecallDirection', () => {
	it('reads the bare arrows only', () => {
		expect(composerRecallDirection({ key: 'ArrowUp' })).toBe('older');
		expect(composerRecallDirection({ key: 'ArrowDown' })).toBe('newer');
		expect(composerRecallDirection({ key: 'ArrowUp', shiftKey: true })).toBeNull();
		expect(composerRecallDirection({ key: 'ArrowUp', altKey: true })).toBeNull();
		expect(composerRecallDirection({ key: 'ArrowUp', metaKey: true })).toBeNull();
		expect(composerRecallDirection({ key: 'ArrowDown', ctrlKey: true })).toBeNull();
		expect(composerRecallDirection({ key: 'ArrowLeft' })).toBeNull();
	});

	it('is the chord the shortcuts page documents', () => {
		const keys = (id: string) => SHORTCUT_CATALOG.find((def) => def.id === id)?.keys;
		expect(keys('chatComposer.recallOlder')).toEqual([COMPOSER_RECALL_OLDER_CHORD]);
		expect(keys('chatComposer.recallNewer')).toEqual([COMPOSER_RECALL_NEWER_CHORD]);
	});
});

describe('caret edges', () => {
	const field = (value: string, start: number, end = start) => ({
		value,
		selectionStart: start,
		selectionEnd: end,
	});

	it('knows the first and last line of a multi-line value', () => {
		expect(caretOnFirstLine(field('', 0))).toBe(true);
		expect(caretOnFirstLine(field('one\ntwo', 2))).toBe(true);
		expect(caretOnFirstLine(field('one\ntwo', 5))).toBe(false);
		expect(caretOnLastLine(field('one\ntwo', 5))).toBe(true);
		expect(caretOnLastLine(field('one\ntwo', 2))).toBe(false);
	});

	it('is never at an edge with text selected', () => {
		expect(caretOnFirstLine(field('one', 0, 3))).toBe(false);
		expect(caretOnLastLine(field('one', 0, 3))).toBe(false);
	});
});

describe('findChatRecallTarget', () => {
	const ME = 'user_me';
	const ROOM = 'room_a';
	const msg = (
		id: string,
		authorId: string,
		extra: Partial<ChatRecallMessage> = {}
	): ChatRecallMessage => ({ _id: id, roomId: ROOM, authorId, text: `text ${id}`, ...extra });
	const find = (
		messages: ChatRecallMessage[],
		over: Partial<Parameters<typeof findChatRecallTarget>[0]> = {}
	) =>
		findChatRecallTarget({
			roomId: ROOM,
			userId: ME,
			messages,
			settled: true,
			hasMore: false,
			canLoadEarlier: true,
			...over,
		});

	it('opens your newest message, past newer messages from others', () => {
		expect(find([msg('m1', ME), msg('m2', ME), msg('m3', 'user_ines')])).toEqual({
			kind: 'edit',
			messageId: 'm2',
		});
	});

	it('skips your deleted and blank messages and assistant replies', () => {
		const messages = [
			msg('m1', ME),
			msg('m2', ME, { deletedAt: 1 }),
			msg('m3', ME, { text: '   ' }),
			msg('m4', ME, { isAssistant: true }),
		];
		expect(find(messages)).toEqual({ kind: 'edit', messageId: 'm1' });
	});

	it('does nothing in a complete history without a message of yours', () => {
		expect(find([msg('m1', 'user_ines')])).toEqual({ kind: 'none' });
		expect(find([])).toEqual({ kind: 'none' });
	});

	it('says the answer is unknown when older history is not loaded', () => {
		expect(find([msg('m1', 'user_ines')], { hasMore: true })).toEqual({
			kind: 'notLoaded',
			canLoadEarlier: true,
		});
		expect(find([msg('m1', 'user_ines')], { hasMore: true, canLoadEarlier: false })).toEqual({
			kind: 'notLoaded',
			canLoadEarlier: false,
		});
	});

	it('still opens a loaded message of yours when older history exists', () => {
		expect(find([msg('m1', ME), msg('m2', 'user_ines')], { hasMore: true })).toEqual({
			kind: 'edit',
			messageId: 'm1',
		});
	});

	it('trusts no list that is loading or belongs to another room', () => {
		const mine = [msg('m1', ME)];
		expect(find(mine, { settled: false })).toEqual({ kind: 'none' });
		expect(find(mine, { roomId: 'room_b' })).toEqual({ kind: 'none' });
		expect(find(mine, { roomId: undefined })).toEqual({ kind: 'none' });
		expect(find(mine, { userId: '' })).toEqual({ kind: 'none' });
	});
});

describe('the Assistant question history', () => {
	const message = (id: string, role: string, text: string) => ({ _id: id, role, text });

	it('keeps your questions, oldest first, one entry per repeat', () => {
		expect(
			buildPromptHistory([
				message('u1', 'user', ' First question '),
				message('a1', 'assistant', 'An answer'),
				message('u2', 'user', 'Second'),
				message('u3', 'user', 'Second'),
				message('u4', 'user', '   '),
			])
		).toEqual([
			{ id: 'u1', prompt: 'First question' },
			{ id: 'u3', prompt: 'Second' },
		]);
	});

	const entries: PromptHistoryEntry[] = [
		{ id: 'u1', prompt: 'first' },
		{ id: 'u2', prompt: 'second' },
		{ id: 'u3', prompt: 'third' },
	];

	it('walks back from an empty box and forward to an empty box again', () => {
		let state = { position: null as PromptHistoryPosition | null, prompt: '' };
		const step = (direction: 'older' | 'newer') => {
			const next = stepPromptHistory({
				direction,
				entries,
				position: state.position,
				current: state.prompt,
			});
			if (next) state = next;
			return next?.prompt ?? null;
		};

		expect(step('older')).toBe('third');
		expect(step('older')).toBe('second');
		expect(step('older')).toBe('first');
		// Nothing older: the key keeps its usual meaning.
		expect(step('older')).toBeNull();
		expect(step('newer')).toBe('second');
		expect(step('newer')).toBe('third');
		expect(step('newer')).toBe('');
		expect(state.position).toBeNull();
		// From the empty box ↓ has nothing to do.
		expect(step('newer')).toBeNull();
	});

	it('never replaces text you typed, nor a recalled question you edited', () => {
		expect(
			stepPromptHistory({ direction: 'older', entries, position: null, current: 'draft' })
		).toBeNull();
		const position = { entryId: 'u3', recalled: 'third' };
		expect(
			stepPromptHistory({ direction: 'older', entries, position, current: 'third, edited' })
		).toBeNull();
		expect(
			stepPromptHistory({ direction: 'newer', entries, position, current: 'third, edited' })
		).toBeNull();
	});

	it('does nothing without questions', () => {
		expect(
			stepPromptHistory({ direction: 'older', entries: [], position: null, current: '' })
		).toBeNull();
	});
});
