/**
 * The page's composer-draft book over the device store.
 *
 * What these cases protect:
 *   - RELOAD. A new book over the same device store (a reload) gets back what
 *     the last one kept, for the same person only.
 *   - TYPING WINS. Text typed, or cleared, before the device copy loads is
 *     never overwritten or brought back by it.
 *   - ORDER. Writes for one draft land in order and coalesce to the newest,
 *     so a slow write never resurrects sent text.
 *   - HONEST DEGRADATION. Without storage the book still holds the text for
 *     the page's lifetime.
 *   - PINNING. A send that settles after the person moved on settles the
 *     draft it sent.
 */
import { describe, expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import {
	createComposerDraftBook,
	teamThreadHasDraft,
	useComposerDraft,
	useComposerDrafts,
} from '../useComposerDrafts';
import { ComposerDraftStore, composerDraftKey } from '~/utils/composerDraftStore';
import { composerDraftTestDriver } from '~/utils/__tests__/composerDraftTestDriver';

function page(driver = composerDraftTestDriver()) {
	const store = new ComposerDraftStore(driver);
	let clock = 1_000;
	return {
		driver,
		book: createComposerDraftBook(
			() => store,
			() => ++clock
		),
	};
}

describe('createComposerDraftBook', () => {
	it('brings a draft back after a reload, for the same person only', async () => {
		const first = page();
		first.book.bindUser('u1');
		first.book.set('chat', 'room1', { text: 'hello', attachments: [] });
		await first.book.idle();

		const reload = page(first.driver);
		reload.book.bindUser('u1');
		await reload.book.idle();
		expect(reload.book.get('chat', 'room1')).toEqual({ text: 'hello', attachments: [] });
		expect(reload.book.has('chat', 'room1')).toBe(true);

		const other = page(first.driver);
		other.book.bindUser('u2');
		await other.book.idle();
		expect(other.book.get('chat', 'room1')).toBeNull();
	});

	it('lets text typed before the device copy loads win, and keeps a cleared draft cleared', async () => {
		const first = page();
		first.book.bindUser('u1');
		first.book.set('assistant', 'assistant', { text: 'stored question' });
		first.book.set('mail-reply', 'th1', { text: 'stored reply' });
		await first.book.idle();

		const reload = page(first.driver);
		const release = reload.driver.hold();
		reload.book.bindUser('u1');
		reload.book.set('assistant', 'assistant', { text: 'typed now' });
		reload.book.set('mail-reply', 'th1', null);
		release();
		await reload.book.idle();

		expect(reload.book.ready.value).toBe(true);
		expect(reload.book.get('assistant', 'assistant')).toEqual({ text: 'typed now' });
		expect(reload.book.get('mail-reply', 'th1')).toBeNull();
		expect(reload.driver.map.has(composerDraftKey('u1', 'mail-reply', 'th1'))).toBe(false);
		expect(reload.driver.map.get(composerDraftKey('u1', 'assistant', 'assistant'))).toMatchObject({
			fields: { text: 'typed now' },
		});
	});

	it('writes one draft in order and coalesces to the newest value', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		await book.idle();
		const release = driver.hold();
		book.set('chat', 'room1', { text: 'a', attachments: [] });
		await flushPromises();
		book.set('chat', 'room1', { text: 'ab', attachments: [] });
		book.set('chat', 'room1', { text: 'abc', attachments: [] });
		book.set('chat', 'room1', null);
		release();
		await book.idle();

		const key = composerDraftKey('u1', 'chat', 'room1');
		expect(driver.log).toEqual([`set ${key}`, `delete ${key}`]);
		expect(driver.map.has(key)).toBe(false);
	});

	it('stores nothing empty, and skips a write that changes nothing', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		await book.idle();
		book.set('answer-note', 'th1', { body: '' });
		book.set('answer-note', 'th2', { body: 'x' });
		book.set('answer-note', 'th2', { body: 'x' });
		await book.idle();
		expect(driver.log).toEqual([`set ${composerDraftKey('u1', 'answer-note', 'th2')}`]);
	});

	it('empties on sign-out and on another person, without touching the device copy', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		book.set('chat', 'room1', { text: 'mine', attachments: [] });
		await book.idle();

		book.bindUser(null);
		expect(book.get('chat', 'room1')).toBeNull();
		book.bindUser('u2');
		await book.idle();
		expect(book.get('chat', 'room1')).toBeNull();
		expect(driver.map.has(composerDraftKey('u1', 'chat', 'room1'))).toBe(true);
	});

	it('still holds the text for the page when the device stores nothing', async () => {
		const { driver, book } = page(composerDraftTestDriver({ persistent: false }));
		book.bindUser('u1');
		book.set('contact-message', 'c1', { text: 'kept for now' });
		await book.idle();
		expect(book.get('contact-message', 'c1')).toEqual({ text: 'kept for now' });
		expect(driver.map.size).toBe(0);
	});

	it('keeps text in memory before anyone is signed in, and writes nothing', async () => {
		const { driver, book } = page();
		book.set('assistant', 'assistant', { text: 'early' });
		await book.idle();
		expect(book.get('assistant', 'assistant')).toEqual({ text: 'early' });
		expect(driver.map.size).toBe(0);
	});

	it('marks a Team inbox thread for any of its drafts with text', () => {
		const { book } = page();
		expect(teamThreadHasDraft(book, 'th1')).toBe(false);
		book.set('channel-reply', 'th1', { text: '', replyToId: 'm1' });
		expect(teamThreadHasDraft(book, 'th1')).toBe(false);
		book.set('team-note', 'team:th1', { body: 'for the team', itemId: null });
		expect(teamThreadHasDraft(book, 'th1')).toBe(true);
		expect(teamThreadHasDraft(book, 'th2')).toBe(false);
	});
});

describe('useComposerDraft', () => {
	it('follows its target, and a pinned update settles the draft it was pinned to', () => {
		useComposerDrafts().bindUser(null);
		const target = ref<string | null>('room1');
		const { draft, pin } = useComposerDraft('chat', () => target.value, {
			text: '',
			attachments: [],
		});
		draft.value = { text: 'for room 1', attachments: [] };
		const settle = pin();
		target.value = 'room2';
		expect(draft.value.text).toBe('');
		draft.value = { text: 'for room 2', attachments: [] };

		settle((now) => (now.text === 'for room 1' ? { text: '', attachments: [] } : now));
		expect(useComposerDrafts().get('chat', 'room1')).toBeNull();
		expect(useComposerDrafts().get('chat', 'room2')).toEqual({
			text: 'for room 2',
			attachments: [],
		});
	});

	it('keeps a box without a target to itself', () => {
		useComposerDrafts().bindUser(null);
		const { draft } = useComposerDraft('answer-note', () => null, { body: 'saved note' });
		expect(draft.value.body).toBe('saved note');
		draft.value = { body: 'edited' };
		expect(draft.value.body).toBe('edited');
		expect(useComposerDrafts().get('answer-note', '')).toBeNull();
	});
});
