/**
 * The device copy of unsent composer text.
 *
 * What these cases protect:
 *   - HONEST WRITES. These drafts have no server copy, so a write reports true
 *     only when it committed on a store that keeps data.
 *   - ISOLATION. One person's drafts never load for another; targets that hold
 *     colons (`team:<id>`) keep their key apart.
 *   - HYGIENE. Malformed records, drafts past retention and the oldest beyond
 *     the cap are deleted on load, but never a draft the caller holds newer
 *     text for, and never a value rewritten after it was read.
 */
import { describe, expect, it } from 'vitest';
import {
	COMPOSER_DRAFT_CAP,
	COMPOSER_DRAFT_RETENTION_MS,
	ComposerDraftStore,
	composerDraftHasContent,
	composerDraftKey,
	isComposerDraftEmpty,
} from '../composerDraftStore';
import { composerDraftTestDriver } from './composerDraftTestDriver';

const NOW = Date.parse('2026-10-22T09:00:00Z');
const never = () => false;

describe('ComposerDraftStore', () => {
	it('loads what was written, by kind and target, for that person only', async () => {
		const driver = composerDraftTestDriver();
		const store = new ComposerDraftStore(driver);
		expect(
			await store.write(
				composerDraftKey('u1', 'team-note', 'team:th1'),
				{ body: 'hi', itemId: 'i1' },
				NOW
			)
		).toBe(true);
		await store.write(
			composerDraftKey('u1', 'chat', 'room1'),
			{
				text: 'later',
				attachments: [{ id: 'a1', filename: 'x.pdf', mimeType: 'application/pdf' }],
			},
			NOW - 1
		);
		await store.write(
			composerDraftKey('u2', 'chat', 'room1'),
			{ text: 'theirs', attachments: [] },
			NOW
		);

		const mine = await store.load('u1', NOW, never);
		expect(mine).toEqual([
			{ kind: 'team-note', target: 'team:th1', savedAt: NOW, fields: { body: 'hi', itemId: 'i1' } },
			{
				kind: 'chat',
				target: 'room1',
				savedAt: NOW - 1,
				fields: {
					text: 'later',
					attachments: [{ id: 'a1', filename: 'x.pdf', mimeType: 'application/pdf' }],
				},
			},
		]);
		expect((await store.load('u2', NOW, never)).map((d) => d.fields)).toEqual([
			{ text: 'theirs', attachments: [] },
		]);
	});

	it('does not read another user whose id starts with this one', async () => {
		const driver = composerDraftTestDriver();
		const store = new ComposerDraftStore(driver);
		await store.write(composerDraftKey('u10', 'assistant', 'assistant'), { text: 'x' }, NOW);
		expect(await store.load('u1', NOW, never)).toEqual([]);
	});

	it('reports a write that went nowhere', async () => {
		const noop = new ComposerDraftStore(composerDraftTestDriver({ persistent: false }));
		expect(
			await noop.write(composerDraftKey('u1', 'assistant', 'assistant'), { text: 'x' }, NOW)
		).toBe(false);
		const failing = new ComposerDraftStore(composerDraftTestDriver({ failWrites: true }));
		expect(
			await failing.write(composerDraftKey('u1', 'assistant', 'assistant'), { text: 'x' }, NOW)
		).toBe(false);
	});

	it('deletes malformed records and records of unknown kinds are left alone', async () => {
		const driver = composerDraftTestDriver();
		const store = new ComposerDraftStore(driver);
		const bad = composerDraftKey('u1', 'chat', 'room1');
		driver.map.set(bad, { v: 1, savedAt: NOW, fields: { text: 'x', attachments: [{ id: 1 }] } });
		const empty = composerDraftKey('u1', 'answer-note', 'th1');
		driver.map.set(empty, { v: 1, savedAt: NOW, fields: { body: '' } });
		const future = 'composer-draft:v1:u1:poll:th1';
		driver.map.set(future, { v: 1, savedAt: NOW, fields: {} });

		expect(await store.load('u1', NOW, never)).toEqual([]);
		expect(driver.map.has(bad)).toBe(false);
		expect(driver.map.has(empty)).toBe(false);
		expect(driver.map.has(future)).toBe(true);
	});

	it('drops drafts past retention and the oldest beyond the cap', async () => {
		const driver = composerDraftTestDriver();
		const store = new ComposerDraftStore(driver);
		const stale = composerDraftKey('u1', 'assistant', 'assistant');
		await store.write(stale, { text: 'old' }, NOW - COMPOSER_DRAFT_RETENTION_MS - 1);
		for (let i = 0; i <= COMPOSER_DRAFT_CAP; i++) {
			await store.write(
				composerDraftKey('u1', 'chat', `room${i}`),
				{ text: `t${i}`, attachments: [] },
				NOW - i
			);
		}

		const loaded = await store.load('u1', NOW, never);
		expect(loaded).toHaveLength(COMPOSER_DRAFT_CAP);
		expect(driver.map.has(stale)).toBe(false);
		expect(driver.map.has(composerDraftKey('u1', 'chat', `room${COMPOSER_DRAFT_CAP}`))).toBe(false);
		expect(driver.map.has(composerDraftKey('u1', 'chat', 'room0'))).toBe(true);
	});

	it('neither returns nor expires a draft the caller skips', async () => {
		const driver = composerDraftTestDriver();
		const store = new ComposerDraftStore(driver);
		const key = composerDraftKey('u1', 'assistant', 'assistant');
		await store.write(key, { text: 'old' }, NOW - COMPOSER_DRAFT_RETENTION_MS - 1);
		expect(await store.load('u1', NOW, (kind) => kind === 'assistant')).toEqual([]);
		expect(driver.map.has(key)).toBe(true);
	});

	it('keeps a draft rewritten between the read and the expiry', async () => {
		const driver = composerDraftTestDriver();
		const store = new ComposerDraftStore(driver);
		const key = composerDraftKey('u1', 'assistant', 'assistant');
		await store.write(key, { text: 'old' }, NOW - COMPOSER_DRAFT_RETENTION_MS - 1);
		const realDeleteIf = driver.deleteIf!;
		driver.deleteIf = async (k, predicate) => {
			driver.map.set(k, { v: 1, savedAt: NOW, fields: { text: 'new' } });
			return realDeleteIf(k, predicate);
		};
		await store.load('u1', NOW, never);
		expect(driver.map.get(key)).toEqual({ v: 1, savedAt: NOW, fields: { text: 'new' } });
	});
});

describe('composer draft kinds', () => {
	it('keeps an open channel reply while its text is empty, but marks only real text', () => {
		expect(isComposerDraftEmpty('channel-reply', { text: '', replyToId: 'm1' })).toBe(false);
		expect(composerDraftHasContent('channel-reply', { text: '', replyToId: 'm1' })).toBe(false);
		expect(isComposerDraftEmpty('channel-reply', { text: '', replyToId: '' })).toBe(true);
	});

	it('counts a chat draft of files alone, and a blank one as nothing', () => {
		const file = { id: 'a', filename: 'a.png', mimeType: 'image/png' };
		expect(composerDraftHasContent('chat', { text: '', attachments: [file] })).toBe(true);
		expect(composerDraftHasContent('chat', { text: '  ', attachments: [] })).toBe(false);
		expect(isComposerDraftEmpty('chat', { text: '  ', attachments: [] })).toBe(false);
	});

	it('treats a team reply of blanks as no reply', () => {
		expect(isComposerDraftEmpty('team-reply', { body: '  ', subject: 'Re: x' })).toBe(true);
	});
});
