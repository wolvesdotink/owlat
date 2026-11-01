/**
 * The subscriptions panel's selection contract.
 *
 * The batch can only finish RFC 8058 One-Click senders. Everything downstream
 * of that fact is what this suite holds:
 *   - a non-one-click sender cannot be ticked, and is offered its own
 *     unsubscribe through the one path (local suppression, then its page);
 *   - "select all" picks the one-click senders and nothing else;
 *   - the action sends exactly those addresses, once the confirm is accepted,
 *     and does nothing at all before the answer or when it is declined;
 *   - the addresses are the ones the question counted, even if the list
 *     changes while it is open, and nothing is sent once the panel is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { installConfirm, type ConfirmDriver } from '~/__tests__/confirm';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip, tooltipOf } from '~/__tests__/tooltip';

import PostboxSubscriptionsPanel from '../PostboxSubscriptionsPanel.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const NOW = Date.now();
const DAY = 86_400_000;

const senders = [
	{
		senderEmail: 'deals@loud.example',
		senderName: 'Daily Deals Now',
		messageCount: 210,
		unreadCount: 200,
		lastReceivedAt: NOW,
		lastReadAt: null,
		method: 'one-click' as const,
		httpUrl: 'https://loud.example/u',
	},
	{
		senderEmail: 'news@northwind.example',
		senderName: 'Northwind Digest',
		messageCount: 52,
		unreadCount: 4,
		lastReceivedAt: NOW - DAY,
		lastReadAt: NOW - 200 * DAY,
		method: 'one-click' as const,
		httpUrl: 'https://northwind.example/u',
	},
	{
		senderEmail: 'hello@manual.example',
		senderName: 'Manual Only',
		messageCount: 8,
		unreadCount: 0,
		lastReceivedAt: NOW - 2 * DAY,
		lastReadAt: NOW - DAY,
		method: 'http' as const,
		actionMessageId: 'msg-manual',
		httpUrl: 'https://manual.example/unsubscribe',
	},
];

const listData = ref<unknown>({ senders, scanned: 42, truncated: false });
const runSpy = vi.fn(async () => ({ ok: true as const, result: { results: [] } }));

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
vi.stubGlobal('useConvexQuery', () => ({
	data: listData,
	error: ref(null),
	isLoading: ref(false),
}));
vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
const senderUnsubscribe = vi.fn(async () => null);
vi.stubGlobal('usePostboxSenderActions', () => ({
	unsubscribe: senderUnsubscribe,
	isBusy: ref(false),
}));

const stubs = {
	UiButton: {
		props: ['disabled', 'loading'],
		template: '<button :disabled="disabled"><slot /></button>',
	},
};

function mountPanel() {
	return mount(PostboxSubscriptionsPanel, {
		props: { mailboxId: 'mb1' as never },
		global: { plugins: [createTestI18n()], stubs },
	});
}

let confirmDriver: ConfirmDriver;
beforeEach(() => {
	runSpy.mockClear();
	listData.value = { senders, scanned: 42, truncated: false };
	confirmDriver = installConfirm();
});
afterEach(() => confirmDriver.dispose());

async function tickAndRun(w: ReturnType<typeof mountPanel>, index: number) {
	await w.findAll('input[type="checkbox"]')[index]!.trigger('change');
	await w
		.findAll('button')
		.find((b) => b.text().includes('Unsubscribe and archive'))!
		.trigger('click');
	await flushPromises();
}

describe('PostboxSubscriptionsPanel', () => {
	it('lists every list sender, loudest first, with volume and last-read', () => {
		const w = mountPanel();
		const rows = w.findAll('li');
		expect(rows).toHaveLength(3);
		expect(rows[0]!.text()).toContain('Daily Deals Now');
		expect(rows[0]!.text()).toContain('210 messages');
		expect(rows[0]!.text()).toContain('Never opened');
		expect(rows[1]!.text()).toContain('Opened 6 months ago');
	});

	it('cannot tick a sender the batch is unable to finish, and unsubscribes it on its own', async () => {
		const w = mountPanel();
		const boxes = w.findAll('input[type="checkbox"]');
		expect(boxes[2]!.attributes('aria-disabled')).toBe('true');
		expect(boxes[0]!.attributes('aria-disabled')).toBeUndefined();
		// Why it is disabled, in a tooltip; the one-click boxes need none.
		expect(boxes[2]!.attributes('title')).toBeUndefined();
		expect(tooltipOf(w, boxes[2]!)).toBe(
			'This sender has no one-click endpoint, so it has to be finished on their own page.'
		);
		expect(tooltipOf(w, boxes[0]!)).toBeUndefined();
		// Not a bare link: the one unsubscribe path (local suppression, then the page).
		expect(w.find('a[href="https://manual.example/unsubscribe"]').exists()).toBe(false);
		await w
			.findAll('button')
			.find((b) => b.text().includes('Open page'))!
			.trigger('click');
		expect(senderUnsubscribe).toHaveBeenCalledWith(
			{ messageId: 'msg-manual' },
			{ mailboxId: 'mb1', name: 'Manual Only' }
		);
	});

	it('keeps a manual-only box focusable for its hint, and a click never ticks it', async () => {
		const w = mount(PostboxSubscriptionsPanel, {
			props: { mailboxId: 'mb1' as never },
			global: { plugins: [createTestI18n()], stubs },
			attachTo: document.body,
		});
		const box = w.findAll('input[type="checkbox"]')[2]!;
		expect(await focusTooltip(box)).toBe(
			'This sender has no one-click endpoint, so it has to be finished on their own page.'
		);
		await box.trigger('click');
		expect((box.element as HTMLInputElement).checked).toBe(false);
		expect(w.text()).not.toContain('has to be finished on its own page');
		w.unmount();
	});

	it('"select all" picks the one-click senders only', async () => {
		const w = mountPanel();
		await w
			.findAll('button')
			.find((b) => b.text().includes('Select all'))!
			.trigger('click');
		const boxes = w.findAll('input[type="checkbox"]');
		expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true);
		expect((boxes[1]!.element as HTMLInputElement).checked).toBe(true);
		expect((boxes[2]!.element as HTMLInputElement).checked).toBe(false);
	});

	it('sends exactly the ticked one-click senders after the confirm', async () => {
		const w = mountPanel();
		await tickAndRun(w, 1);
		expect(confirmDriver.pending[0]).toMatchObject({
			title: 'Unsubscribe from 1 sender and archive their mail?',
			confirmText: 'Unsubscribe and archive',
			variant: 'warning',
		});
		expect(runSpy).not.toHaveBeenCalled();

		confirmDriver.answer(true);
		await flushPromises();
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mb1',
			senderEmails: ['news@northwind.example'],
		});
	});

	it('does nothing when the confirm is declined', async () => {
		const w = mountPanel();
		await tickAndRun(w, 0);
		confirmDriver.answer(false);
		await flushPromises();
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('sends the senders the question named, not a selection changed while it was open', async () => {
		const w = mountPanel();
		await tickAndRun(w, 1);
		// The list re-sorts and the person's ticks move on underneath the dialog.
		await w.findAll('input[type="checkbox"]')[0]!.trigger('change');
		confirmDriver.answer(true);
		await flushPromises();
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mb1',
			senderEmails: ['news@northwind.example'],
		});
	});

	it('sends nothing when the panel goes away with the question open', async () => {
		const w = mountPanel();
		await tickAndRun(w, 1);
		w.unmount();
		expect(confirmDriver.pending).toEqual([]);
		await flushPromises();
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('renders the empty state when no list mail was found', () => {
		listData.value = { senders: [], scanned: 0, truncated: false };
		const w = mountPanel();
		expect(w.text()).toContain('No subscriptions found');
	});
});
