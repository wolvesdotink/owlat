/**
 * The bulk bar's ⋯ overflow — the five demoted verbs and their contextual
 * swaps.
 *
 * Demoting a verb behind a menu is only safe if the menu still offers exactly
 * what the bar did, in exactly the folders it did. So: the contextual swaps
 * (Trash → Delete forever, Spam → Not spam, snoozed → Unsnooze) are asserted
 * per folder, and both destructive verbs still go through their confirm: nothing
 * runs before the answer or after a no, and a yes acts on the rows and senders
 * the question counted, not on a selection changed while it was open.
 *
 * Unsubscribe carries its own two ways to lie: it may only appear when the
 * backend says the selection holds One-Click list mail (a page-only newsletter
 * has nothing this verb can finish), and when it runs it must carry the
 * SELECTED message ids, not just the sender addresses — the ids are what let
 * the action reach mail outside the subscriptions panel's inbox window, which
 * is where a selection in Archive or Spam lives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { installConfirm, type ConfirmDriver } from '~/__tests__/confirm';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxBulkOverflowMenu from '../PostboxBulkOverflowMenu.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const selectionSenders = ref<unknown>([]);
const selectedIds = ref<string[]>(['m1', 'm2']);
const runSpy = vi.fn(async () => ({
	ok: true as const,
	result: { results: [{ senderEmail: 'news@a.example', status: 'unsubscribed', archived: 12 }] },
}));
const clearSpy = vi.fn();
const purgeSpy = vi.fn();
const notSpamSpy = vi.fn();
const reportSpamSpy = vi.fn();
const showToast = vi.fn();

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
vi.stubGlobal('useConvexQuery', () => ({
	data: selectionSenders,
	error: ref(null),
	isLoading: ref(false),
}));
vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
vi.stubGlobal('useToast', () => ({ showToast }));
vi.stubGlobal('usePostboxBulkActions', () => ({
	ids: selectedIds,
	count: ref(selectedIds.value.length),
	clear: clearSpy,
	purgeSelected: purgeSpy,
	reportSpamSelected: reportSpamSpy,
	notSpamSelected: notSpamSpy,
}));
const labels = ref<Array<{ _id: string; name: string; color?: string }>>([]);
vi.stubGlobal('usePostboxLabels', () => ({ labels, setOnMessage: vi.fn() }));

/**
 * The panel is `v-if`-ed in the real menu, so the stub renders the slot open —
 * these cases are about WHAT the overflow offers, not about how it opens (that
 * is PostboxOverflowMenu's own suite).
 */
const stubs = {
	PostboxOverflowMenu: {
		props: ['label'],
		template: '<div role="menu"><slot :close="() => {}" /></div>',
	},
	Icon: { props: ['name'], template: '<span />' },
	PostboxSnoozeDialog: true,
};

function mountMenu(folderRole = 'archive') {
	return mount(PostboxBulkOverflowMenu, {
		props: { mailboxId: 'mb1' as never, folderRole },
		global: { plugins: [createTestI18n()], stubs },
	});
}

const itemNamed = (wrapper: ReturnType<typeof mountMenu>, text: string) =>
	wrapper.findAll('button').find((b) => b.text().includes(text));

let confirmDriver: ConfirmDriver;
beforeEach(() => {
	runSpy.mockClear();
	clearSpy.mockClear();
	purgeSpy.mockClear();
	notSpamSpy.mockClear();
	reportSpamSpy.mockClear();
	showToast.mockClear();
	selectedIds.value = ['m1', 'm2'];
	selectionSenders.value = [];
	labels.value = [];
	confirmDriver = installConfirm();
});
afterEach(() => confirmDriver.dispose());

/** Click an item, then answer the question it asked. */
async function clickAndAnswer(
	wrapper: ReturnType<typeof mountMenu>,
	text: string,
	confirmed: boolean
) {
	await itemNamed(wrapper, text)!.trigger('click');
	await flushPromises();
	confirmDriver.answer(confirmed);
	await flushPromises();
}

describe('PostboxBulkOverflowMenu contents', () => {
	it('offers the five demoted verbs in an ordinary folder', () => {
		const w = mountMenu();
		expect(itemNamed(w, 'Label')).toBeDefined();
		expect(itemNamed(w, 'Snooze')).toBeDefined();
		expect(itemNamed(w, 'Spam')).toBeDefined();
		// Delete forever and Unsubscribe are folder/selection gated, not global.
		expect(itemNamed(w, 'Delete forever')).toBeUndefined();
	});

	it('swaps Snooze for Unsnooze in the snoozed folder', () => {
		const w = mountMenu('snoozed');
		expect(itemNamed(w, 'Un-snooze')).toBeDefined();
		expect(w.findAll('button').some((b) => b.text().trim() === 'Snooze')).toBe(false);
	});

	it('swaps Spam for Not spam inside Spam', () => {
		const w = mountMenu('spam');
		expect(itemNamed(w, 'Not spam')).toBeDefined();
		expect(w.findAll('button').some((b) => b.text().trim() === 'Spam')).toBe(false);
	});

	it('offers Delete forever only from Trash, behind a confirm', async () => {
		expect(itemNamed(mountMenu('archive'), 'Delete forever')).toBeUndefined();

		const w = mountMenu('trash');
		await itemNamed(w, 'Delete forever')!.trigger('click');
		await flushPromises();
		expect(confirmDriver.pending[0]).toMatchObject({
			title: 'Permanently delete 2 messages?',
			body: 'This cannot be undone.',
			confirmText: 'Delete forever',
			variant: 'danger',
		});
		expect(purgeSpy).not.toHaveBeenCalled();
		confirmDriver.answer(true);
		await flushPromises();
		expect(purgeSpy).toHaveBeenCalledTimes(1);
		expect(purgeSpy).toHaveBeenCalledWith(['m1', 'm2']);

		purgeSpy.mockClear();
		await clickAndAnswer(mountMenu('trash'), 'Delete forever', false);
		expect(purgeSpy).not.toHaveBeenCalled();
	});

	it('purges the rows the question counted, not rows selected while it was open', async () => {
		const w = mountMenu('trash');
		await itemNamed(w, 'Delete forever')!.trigger('click');
		await flushPromises();
		selectedIds.value = ['m1', 'm2', 'm3'];
		confirmDriver.answer(true);
		await flushPromises();
		expect(purgeSpy).toHaveBeenCalledWith(['m1', 'm2']);
	});

	it('expands the label list inside the panel instead of a second popover', async () => {
		labels.value = [{ _id: 'lbl-1', name: 'Billing', color: '#123456' }];
		const w = mountMenu();
		expect(itemNamed(w, 'Billing')).toBeUndefined();

		await itemNamed(w, 'Label')!.trigger('click');
		expect(itemNamed(w, 'Billing')).toBeDefined();

		await itemNamed(w, 'Billing')!.trigger('click');
		expect(runSpy).toHaveBeenCalledWith({
			messageIds: ['m1', 'm2'],
			labelId: 'lbl-1',
			add: true,
		});
	});
});

describe('PostboxBulkOverflowMenu unsubscribe', () => {
	it('stays hidden when the selection holds nothing One-Click', () => {
		expect(itemNamed(mountMenu(), 'Unsubscribe')).toBeUndefined();
	});

	it('sends the selected message ids alongside the senders', async () => {
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountMenu();
		await itemNamed(w, 'Unsubscribe')!.trigger('click');
		await flushPromises();
		expect(confirmDriver.pending[0]).toMatchObject({
			title: 'Unsubscribe from 1 sender and archive their mail?',
			confirmText: 'Unsubscribe',
			variant: 'warning',
		});
		expect(runSpy).not.toHaveBeenCalled();
		// The selection moves on while the question is open; the request still
		// carries what was selected when it was asked.
		selectedIds.value = ['m9'];
		selectionSenders.value = [{ senderEmail: 'other@b.example', actionMessageId: 'm9' }];
		confirmDriver.answer(true);
		await flushPromises();
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mb1',
			senderEmails: ['news@a.example'],
			messageIds: ['m1', 'm2'],
		});
	});

	it('reports every line of the outcome, not just the headline', async () => {
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountMenu();
		await clickAndAnswer(w, 'Unsubscribe', true);
		const [message, tone] = showToast.mock.calls[0] ?? [];
		expect(message).toContain('Unsubscribed from 1 sender');
		expect(message).toContain('12 messages archived');
		expect(tone).toBe('success');
	});

	it('does nothing when the confirm is declined', async () => {
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountMenu();
		await clickAndAnswer(w, 'Unsubscribe', false);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('sends nothing when the menu goes away with the question open', async () => {
		selectionSenders.value = [{ senderEmail: 'news@a.example', actionMessageId: 'm2' }];
		const w = mountMenu();
		await itemNamed(w, 'Unsubscribe')!.trigger('click');
		await flushPromises();
		w.unmount();
		await flushPromises();
		expect(confirmDriver.pending).toEqual([]);
		expect(runSpy).not.toHaveBeenCalled();
	});
});
