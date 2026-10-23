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
 *   - PINNING. A send or upload that settles after the person moved on (to
 *     another target, or another account) settles the draft it started from
 *     and never touches anyone else's.
 *   - NEWER ELSEWHERE. A delete takes only the stored copy this page read or
 *     wrote; newer text another tab saved stays on the device.
 *   - SWITCHING. Changes still on their way when the account switches land
 *     for the person who made them, and that person's copy loads again only
 *     after they have.
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

	it('reports text that exists only in this page until its write commits', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		await book.idle();
		const release = driver.hold();
		book.set('chat', 'room1', { text: 'on its way', attachments: [] });
		expect(book.hasUnstoredDrafts()).toBe(true);
		release();
		await book.idle();
		expect(book.hasUnstoredDrafts()).toBe(false);
	});

	it('keeps reporting a draft whose write failed, until it is cleared or stored', async () => {
		const failing = page(composerDraftTestDriver({ failWrites: true }));
		failing.book.bindUser('u1');
		failing.book.set('team-reply', 'th1', { body: 'not on the device', subject: '' });
		await failing.book.idle();
		expect(failing.book.hasUnstoredDrafts()).toBe(true);
		failing.book.set('team-reply', 'th1', null);
		await failing.book.idle();
		expect(failing.book.hasUnstoredDrafts()).toBe(false);

		const memoryOnly = page(composerDraftTestDriver({ persistent: false }));
		memoryOnly.book.bindUser('u1');
		memoryOnly.book.set('contact-message', 'c1', { text: 'kept for now' });
		await memoryOnly.book.idle();
		expect(memoryOnly.book.hasUnstoredDrafts()).toBe(true);
		// Another person's book holds none of it: their reload loses nothing.
		memoryOnly.book.bindUser('u2');
		await memoryOnly.book.idle();
		expect(memoryOnly.book.hasUnstoredDrafts()).toBe(false);
	});

	it('keeps text in memory before anyone is signed in, and writes nothing', async () => {
		const { driver, book } = page();
		book.set('assistant', 'assistant', { text: 'early' });
		await book.idle();
		expect(book.get('assistant', 'assistant')).toEqual({ text: 'early' });
		expect(driver.map.size).toBe(0);
	});

	it('leaves newer text another tab saved when this one sends its older copy', async () => {
		const tabA = page();
		tabA.book.bindUser('u1');
		tabA.book.set('chat', 'room1', { text: 'first words', attachments: [] });
		await tabA.book.idle();
		const tabB = page(tabA.driver);
		tabB.book.bindUser('u1');
		await tabB.book.idle();
		tabB.book.set('chat', 'room1', { text: 'first words, then more', attachments: [] });
		await tabB.book.idle();

		// Tab A sends what it shows and lets it go.
		tabA.book.pin('chat', 'room1')(() => null);
		await tabA.book.idle();
		const key = composerDraftKey('u1', 'chat', 'room1');
		expect(tabA.driver.map.get(key)).toMatchObject({
			fields: { text: 'first words, then more' },
		});

		// Without a conflict the same send does delete it.
		tabB.book.set('chat', 'room1', null);
		await tabB.book.idle();
		expect(tabA.driver.map.has(key)).toBe(false);
	});

	it('does not delete a copy saved after this page loaded and never read here', async () => {
		const tabA = page();
		tabA.book.bindUser('u1');
		await tabA.book.idle();
		const tabB = page(tabA.driver);
		tabB.book.bindUser('u1');
		tabB.book.set('assistant', 'assistant', { text: 'from tab B' });
		await tabB.book.idle();

		tabA.book.set('assistant', 'assistant', { text: 'x' });
		await tabA.book.idle();
		tabA.book.set('assistant', 'assistant', null);
		await tabA.book.idle();
		// Tab A's own write replaced it: that one, and only that one, it may delete.
		expect(tabA.driver.map.has(composerDraftKey('u1', 'assistant', 'assistant'))).toBe(false);

		tabB.book.set('mail-reply', 'th1', { text: 'B only' });
		await tabB.book.idle();
		tabA.book.pin('mail-reply', 'th1')(() => null);
		await tabA.book.idle();
		expect(tabA.driver.map.has(composerDraftKey('u1', 'mail-reply', 'th1'))).toBe(true);
	});

	it('settles a send or an upload for the person who started it, after another signs in', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		book.set('chat', 'room1', { text: 'sent by u1', attachments: [] });
		book.set('chat', 'room2', { text: 'u1 is uploading', attachments: [] });
		await book.idle();
		const sent = book.pin('chat', 'room1');
		const uploaded = book.pin('chat', 'room2');

		book.bindUser('u2');
		book.set('chat', 'room1', { text: 'u2 in room 1', attachments: [] });
		book.set('chat', 'room2', { text: 'u2 in room 2', attachments: [] });
		const file = { id: 'a1', filename: 'a.pdf', mimeType: 'application/pdf' };
		sent((now) => (now?.text === 'sent by u1' ? null : now));
		uploaded((now) => ({
			text: now?.text ?? '',
			attachments: [...(now?.attachments ?? []), file],
		}));
		await book.idle();

		expect(book.get('chat', 'room1')).toEqual({ text: 'u2 in room 1', attachments: [] });
		expect(book.get('chat', 'room2')).toEqual({ text: 'u2 in room 2', attachments: [] });
		expect(driver.map.get(composerDraftKey('u2', 'chat', 'room2'))).toMatchObject({
			fields: { text: 'u2 in room 2', attachments: [] },
		});
		// u1's own device copy took both.
		expect(driver.map.has(composerDraftKey('u1', 'chat', 'room1'))).toBe(false);
		expect(driver.map.get(composerDraftKey('u1', 'chat', 'room2'))).toMatchObject({
			fields: { text: 'u1 is uploading', attachments: [file] },
		});
	});

	it('settles in the book when the same person is back, and drops a settle from nobody', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		book.set('answer-note', 'th1', { body: 'note' });
		await book.idle();
		const settle = book.pin('answer-note', 'th1');
		book.bindUser(null);
		const fromNobody = book.pin('answer-note', 'th2');
		book.bindUser('u1');
		settle(() => null);
		fromNobody(() => ({ body: 'stray' }));
		await book.idle();
		expect(book.get('answer-note', 'th1')).toBeNull();
		expect(book.get('answer-note', 'th2')).toBeNull();
		expect(driver.map.size).toBe(0);
	});

	it('still deletes a cleared draft when another person signs in before the delete lands', async () => {
		const first = page();
		first.book.bindUser('u1');
		first.book.set('assistant', 'assistant', { text: 'kept from before' });
		await first.book.idle();
		const { driver, book } = page(first.driver);
		book.bindUser('u1');
		await book.idle();

		const release = driver.hold();
		book.set('assistant', 'assistant', null);
		book.bindUser('u2');
		release();
		await book.idle();
		expect(driver.map.has(composerDraftKey('u1', 'assistant', 'assistant'))).toBe(false);

		const reload = page(driver);
		reload.book.bindUser('u1');
		await reload.book.idle();
		expect(reload.book.get('assistant', 'assistant')).toBeNull();
	});

	it('loads a returning person’s copy only after their pending changes have landed', async () => {
		const { driver, book } = page();
		book.bindUser('u1');
		book.set('chat', 'room1', { text: 'sent by u1', attachments: [] });
		book.set('mail-reply', 'th1', { text: 'cleared by u1' });
		await book.idle();
		const sent = book.pin('chat', 'room1');

		// Deletes stay in flight until released; reads go through.
		let releaseDeletes!: () => void;
		const deletesHeld = new Promise<void>((resolve) => (releaseDeletes = resolve));
		const deleteIf = driver.deleteIf!.bind(driver);
		driver.deleteIf = async (key, predicate) => {
			await deletesHeld;
			return deleteIf(key, predicate);
		};
		book.set('mail-reply', 'th1', null);
		book.bindUser('u2');
		// u1's send settles while u2 is signed in, then u1 comes back at once.
		sent((now) => (now?.text === 'sent by u1' ? null : now));
		book.bindUser('u1');
		await flushPromises();
		expect(book.ready.value).toBe(false);
		releaseDeletes();
		await book.idle();

		expect(book.get('chat', 'room1')).toBeNull();
		expect(book.get('mail-reply', 'th1')).toBeNull();
		expect(driver.map.size).toBe(0);
	});

	it('tells pinned work whether the person it started for is still signed in', async () => {
		const { book } = page();
		book.bindUser('u1');
		await book.idle();
		const settle = book.pin('chat', 'room1');
		expect(settle.owned()).toBe(true);
		book.bindUser('u2');
		expect(settle.owned()).toBe(false);
		book.bindUser('u1');
		// Back, but after a switch: work under the old session does not resume.
		expect(settle.owned()).toBe(false);
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
