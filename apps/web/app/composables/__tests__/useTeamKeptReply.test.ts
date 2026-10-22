/**
 * The Team inbox reply kept on the device, through Answer mode's editor.
 *
 * What these cases protect:
 *   - KEPT AS TYPED. The text is stored while the person types, not when the
 *     page unmounts (a reload never unmounts it), with its subject and its
 *     saved-reply gap guard.
 *   - LATE DEVICE COPY. A copy that loads after the editor appeared fills an
 *     untouched editor and never one the person is already typing in.
 *   - LET GO ON PURPOSE. An editor that goes back to untouched (the agent's
 *     draft restored) drops the kept text; a new editor for another message
 *     does not.
 *   - ONLY WHAT WAS SENT. A send that is accepted forgets the text it sent and
 *     resets the editor only if it still holds exactly that; text typed while
 *     it was in flight stays, and a send that finishes after another person
 *     signed in never touches their draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, shallowRef } from 'vue';
import { composerDraftKey } from '~/utils/composerDraftStore';
import type { ComposerDraftTestDriver } from '~/utils/__tests__/composerDraftTestDriver';

const device = vi.hoisted(() => ({ driver: null as unknown }));
vi.mock('~/utils/postboxOfflineKvDriver', () => ({ getOfflineKvDriver: () => device.driver }));

beforeEach(async () => {
	const { composerDraftTestDriver } = await import('~/utils/__tests__/composerDraftTestDriver');
	device.driver = composerDraftTestDriver();
});

const driver = () => device.driver as ComposerDraftTestDriver;

function editor(initial: { body?: string; touched?: boolean } = {}) {
	const state = reactive({
		body: initial.body ?? '',
		subject: 'Re: Invoice',
		touched: initial.touched ?? false,
		gapGuarded: false,
	});
	return {
		state,
		api: {
			fill(body: string, subject: string, gapGuarded = false) {
				Object.assign(state, { body, subject, gapGuarded, touched: true });
			},
			reset() {
				Object.assign(state, { body: '', touched: false, gapGuarded: false });
			},
			snapshot: () => ({ ...state }),
		},
	};
}

/** A fresh page over the same device: new modules, a new book. */
async function openPage(options: { holdDevice?: boolean } = {}) {
	vi.resetModules();
	const { useComposerDrafts } = await import('../useComposerDrafts');
	const { useKeptTeamComposer, useTeamKeptReply } = await import('../useTeamKeptReply');
	const release = options.holdDevice ? driver().hold() : () => {};
	const book = useComposerDrafts();
	book.bindUser('u1');
	const composer = shallowRef<ReturnType<typeof editor>['api'] | null>(null);
	const scope = effectScope();
	const kept = scope.run(() => useKeptTeamComposer(() => 'th1', composer))!;
	return { book, composer, kept, release, reply: useTeamKeptReply() };
}

describe('useKeptTeamComposer', () => {
	it('keeps the reply as it is typed and puts it back after a reload', async () => {
		const first = await openPage();
		await first.book.idle();
		const typing = editor();
		first.composer.value = typing.api;
		await nextTick();
		Object.assign(typing.state, { body: 'Refund is on its way', touched: true, gapGuarded: true });
		await nextTick();
		await first.book.idle();
		expect(driver().map.get(composerDraftKey('u1', 'team-reply', 'th1'))).toMatchObject({
			fields: { body: 'Refund is on its way', subject: 'Re: Invoice', gapGuarded: true },
		});

		const reload = await openPage();
		await reload.book.idle();
		const restored = editor({ body: 'the agent draft' });
		reload.composer.value = restored.api;
		await nextTick();
		expect(restored.state).toMatchObject({
			body: 'Refund is on its way',
			gapGuarded: true,
			touched: true,
		});
	});

	it('fills an untouched editor when the device copy arrives late, never a touched one', async () => {
		const first = await openPage();
		first.reply.set('th1', { body: 'kept text', subject: 'Re: Invoice' });
		await first.book.idle();

		const late = await openPage({ holdDevice: true });
		const waiting = editor({ body: 'the agent draft' });
		late.composer.value = waiting.api;
		await nextTick();
		late.release();
		await late.book.idle();
		await nextTick();
		expect(waiting.state.body).toBe('kept text');

		const busy = await openPage({ holdDevice: true });
		const typing = editor();
		busy.composer.value = typing.api;
		await nextTick();
		Object.assign(typing.state, { body: 'new words', touched: true });
		await nextTick();
		busy.release();
		await busy.book.idle();
		await nextTick();
		expect(typing.state.body).toBe('new words');
		expect(busy.reply.get('th1')?.body).toBe('new words');
	});

	it('drops the kept text when the editor is reset, not when a new editor appears', async () => {
		const page = await openPage();
		await page.book.idle();
		const first = editor();
		page.composer.value = first.api;
		await nextTick();
		Object.assign(first.state, { body: 'half a reply', touched: true });
		await nextTick();

		// Another message to answer: a new, untouched editor takes the text.
		const second = editor({ body: 'agent draft for the newer message' });
		page.composer.value = second.api;
		await nextTick();
		expect(page.reply.get('th1')?.body).toBe('half a reply');
		expect(second.state.body).toBe('half a reply');

		// The agent's draft restored: the editor is untouched again.
		Object.assign(second.state, { body: '', touched: false });
		await nextTick();
		await page.book.idle();
		expect(page.reply.get('th1')).toBeNull();
		expect(driver().map.has(composerDraftKey('u1', 'team-reply', 'th1'))).toBe(false);
	});

	it('forgets the sent reply and resets the editor once the send is accepted', async () => {
		const page = await openPage();
		await page.book.idle();
		const typing = editor();
		page.composer.value = typing.api;
		await nextTick();
		Object.assign(typing.state, { body: 'Refund sent', touched: true });
		await nextTick();

		const settle = page.kept.sending({ body: 'Refund sent', subject: 'Re: Invoice' });
		settle();
		await nextTick();
		await page.book.idle();
		expect(typing.state).toMatchObject({ body: '', touched: false });
		expect(page.reply.get('th1')).toBeNull();
		expect(driver().map.has(composerDraftKey('u1', 'team-reply', 'th1'))).toBe(false);
	});

	it('keeps text typed while the send was in flight, in the editor and on the device', async () => {
		const page = await openPage();
		await page.book.idle();
		const typing = editor();
		page.composer.value = typing.api;
		await nextTick();
		Object.assign(typing.state, { body: 'Refund sent', touched: true });
		await nextTick();

		const settle = page.kept.sending({ body: 'Refund sent', subject: 'Re: Invoice' });
		Object.assign(typing.state, { body: 'Refund sent. One more thing', touched: true });
		await nextTick();
		settle();
		await nextTick();
		await page.book.idle();
		expect(typing.state).toMatchObject({ body: 'Refund sent. One more thing', touched: true });
		expect(page.reply.get('th1')?.body).toBe('Refund sent. One more thing');
		expect(driver().map.get(composerDraftKey('u1', 'team-reply', 'th1'))).toMatchObject({
			fields: { body: 'Refund sent. One more thing' },
		});
	});

	it('settles a send that finishes after another person signed in on their own copy only', async () => {
		const page = await openPage();
		await page.book.idle();
		page.reply.set('th1', { body: 'Refund sent', subject: 'Re: Invoice' });
		await page.book.idle();
		const settle = page.kept.sending({ body: 'Refund sent', subject: 'Re: Invoice' });

		page.book.bindUser('u2');
		await page.book.idle();
		page.reply.set('th1', { body: 'u2 is writing', subject: 'Re: Invoice' });
		settle();
		await page.book.idle();
		expect(page.reply.get('th1')?.body).toBe('u2 is writing');
		expect(driver().map.has(composerDraftKey('u1', 'team-reply', 'th1'))).toBe(false);
		expect(driver().map.get(composerDraftKey('u2', 'team-reply', 'th1'))).toMatchObject({
			fields: { body: 'u2 is writing' },
		});
	});
});
