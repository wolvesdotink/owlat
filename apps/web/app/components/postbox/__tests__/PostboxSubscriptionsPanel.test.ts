// @vitest-environment happy-dom
/**
 * The subscriptions panel's selection contract.
 *
 * The batch can only finish RFC 8058 One-Click senders. Everything downstream
 * of that fact is what this suite holds:
 *   - a non-one-click sender cannot be ticked, and is offered its own page;
 *   - "select all" picks the one-click senders and nothing else;
 *   - the action sends exactly those addresses, once the confirm is accepted,
 *     and does nothing at all when it is declined.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

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

const stubs = {
	UiButton: {
		props: ['disabled', 'loading'],
		template: '<button :disabled="disabled"><slot /></button>',
	},
	Icon: { props: ['name'], template: '<span />' },
};

function mountPanel() {
	return mount(PostboxSubscriptionsPanel, {
		props: { mailboxId: 'mb1' as never },
		global: { plugins: [createTestI18n()], stubs },
	});
}

beforeEach(() => {
	runSpy.mockClear();
	listData.value = { senders, scanned: 42, truncated: false };
});

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

	it('cannot tick a sender the batch is unable to finish, and links their page', () => {
		const w = mountPanel();
		const boxes = w.findAll('input[type="checkbox"]');
		expect(boxes[2]!.attributes('disabled')).toBeDefined();
		expect(w.find('a[href="https://manual.example/unsubscribe"]').exists()).toBe(true);
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
		vi.stubGlobal('confirm', () => true);
		const w = mountPanel();
		await w.findAll('input[type="checkbox"]')[1]!.trigger('change');
		await w
			.findAll('button')
			.find((b) => b.text().includes('Unsubscribe and archive'))!
			.trigger('click');
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mb1',
			senderEmails: ['news@northwind.example'],
		});
	});

	it('does nothing when the confirm is declined', async () => {
		vi.stubGlobal('confirm', () => false);
		const w = mountPanel();
		await w.findAll('input[type="checkbox"]')[0]!.trigger('change');
		await w
			.findAll('button')
			.find((b) => b.text().includes('Unsubscribe and archive'))!
			.trigger('click');
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('renders the empty state when no list mail was found', () => {
		listData.value = { senders: [], scanned: 0, truncated: false };
		const w = mountPanel();
		expect(w.text()).toContain('No subscriptions found');
	});
});
