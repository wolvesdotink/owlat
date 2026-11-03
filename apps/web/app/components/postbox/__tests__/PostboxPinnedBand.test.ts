/**
 * The Inbox's pinned band (PostboxPinnedBand + usePostboxPins).
 *
 * It renders the band query's conversations in pin order, opens them by route
 * (Browse) or in place (Priority), unpins through the one pin operation, is a
 * drop target that pins dragged rows, appears while a drag is in flight even
 * when empty, and refuses a drop once it is full.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxMessageDrag } from '~/composables/postbox/usePostboxMessageDrag';
import { optimisticUnpin } from '~/composables/postbox/usePostboxPins';
import PostboxPinnedBand from '../PostboxPinnedBand.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Conversation = {
	threadId: string;
	messageId: string;
	subject: string;
	fromAddress: string;
	fromName?: string;
	lastMessageAt: number;
	unreadCount: number;
	messageCount: number;
	pinnedAt: number;
};

const conversation = (n: number, extra: Partial<Conversation> = {}): Conversation => ({
	threadId: `t${n}`,
	messageId: `m${n}`,
	subject: `Subject ${n}`,
	fromAddress: `sender${n}@example.com`,
	lastMessageAt: Date.now() - n * 60_000,
	unreadCount: 0,
	messageCount: 1,
	pinnedAt: n,
	...extra,
});

const data = ref<{ conversations: Conversation[]; limit: number } | undefined>(undefined);
const queryArgs = vi.fn();
const run = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useConvexQuery: (_query: unknown, args: () => unknown) => {
			queryArgs(args());
			return { data, isLoading: ref(false), error: ref(null) };
		},
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
	});
});

beforeEach(() => {
	data.value = {
		conversations: [conversation(1, { fromName: 'Ines', unreadCount: 2 }), conversation(2)],
		limit: 5,
	};
	queryArgs.mockReset();
	run.mockReset();
	run.mockResolvedValue({ ok: true, result: { ok: true } });
});

afterEach(() => usePostboxMessageDrag().end());

function mountBand(props: Record<string, unknown> = {}) {
	return mount(PostboxPinnedBand, {
		props: { mailboxId: 'mbx-1' as never, ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

function startDrag(messageIds: string[], mailboxId = 'mbx-1') {
	usePostboxMessageDrag().start(
		{ dataTransfer: { setData: vi.fn(), setDragImage: vi.fn() } } as unknown as DragEvent,
		{
			mailboxId: mailboxId as never,
			messageIds: messageIds as never,
			sourceFolder: 'inbox',
			moveTo: vi.fn(async () => {}),
		},
		'Subject'
	);
}

/** Dispatch a cancelable drag event; `true` means the band claimed it. */
function fire(el: Element, type: string) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	return event.defaultPrevented;
}

const band = (w: ReturnType<typeof mountBand>) => w.find('[data-testid="postbox-pinned-band"]');

describe('PostboxPinnedBand', () => {
	it('lists the mailbox pins in order, linking to each newest message', () => {
		const w = mountBand();
		expect(queryArgs).toHaveBeenCalledWith({ mailboxId: 'mbx-1' });
		const entries = w.findAll('[data-testid="postbox-pinned-entry"]');
		expect(entries.map((e) => e.attributes('href'))).toEqual([
			'/dashboard/postbox/inbox/m1',
			'/dashboard/postbox/inbox/m2',
		]);
		expect(entries[0]!.text()).toContain('Ines');
		expect(entries[0]!.text()).toContain('Subject 1');
		// Without a display name the address stands in.
		expect(entries[1]!.text()).toContain('sender2@example.com');
		expect(band(w).text()).toContain('2 of 5');
	});

	it('opens entries in place when selectable, marking the open one', async () => {
		const w = mountBand({ selectable: true, activeMessageId: 'm2' });
		const entries = w.findAll('[data-testid="postbox-pinned-entry"]');
		expect(entries[0]!.element.tagName).toBe('BUTTON');
		expect(entries[1]!.attributes('aria-current')).toBe('true');
		await entries[0]!.trigger('click');
		expect(w.emitted('select')).toEqual([['m1']]);
	});

	it('unpins through the pin operation, by the entry message', async () => {
		const w = mountBand();
		const unpin = w.findAll('[data-testid="postbox-pinned-unpin"]')[1]!;
		expect(unpin.attributes('aria-label')).toBe('Unpin “Subject 2”');
		await unpin.trigger('click');
		expect(run).toHaveBeenCalledWith({ messageIds: ['m2'], pinned: false });
	});

	it('renders nothing with no pins, and appears as the drop target during a drag', async () => {
		data.value = { conversations: [], limit: 5 };
		const w = mountBand();
		expect(band(w).exists()).toBe(false);
		startDrag(['m7', 'm8']);
		await nextTick();
		expect(band(w).text()).toContain('Drop here to pin');
		expect(fire(band(w).element, 'dragover')).toBe(true);
		await nextTick();
		expect(band(w).classes()).toContain('pbx-drop-target');
		expect(fire(band(w).element, 'drop')).toBe(true);
		expect(run).toHaveBeenCalledWith({ messageIds: ['m7', 'm8'], pinned: true });
	});

	it('refuses a drop when full, and one from another mailbox', async () => {
		data.value = { conversations: [1, 2, 3, 4, 5].map((n) => conversation(n)), limit: 5 };
		const w = mountBand();
		startDrag(['m9']);
		await nextTick();
		expect(band(w).text()).toContain('You can pin up to 5 conversations');
		expect(fire(band(w).element, 'dragover')).toBe(false);
		expect(fire(band(w).element, 'drop')).toBe(false);
		usePostboxMessageDrag().end();

		data.value = { conversations: [conversation(1)], limit: 5 };
		startDrag(['m9'], 'mbx-2');
		await nextTick();
		expect(fire(band(w).element, 'dragover')).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});
});

describe('optimisticUnpin', () => {
	function store(value: { conversations: Conversation[]; limit: number }) {
		const setQuery = vi.fn();
		return {
			setQuery,
			store: {
				getAllQueries: () => [{ args: { mailboxId: 'mbx-1' }, value }],
				setQuery,
			} as never,
		};
	}

	it('drops the unpinned entry from the band at once', () => {
		const value = { conversations: [conversation(1), conversation(2)], limit: 5 };
		const s = store(value);
		optimisticUnpin(s.store, { messageIds: ['m1'] as never, pinned: false });
		expect(s.setQuery).toHaveBeenCalledWith(
			expect.anything(),
			{ mailboxId: 'mbx-1' },
			{
				conversations: [value.conversations[1]],
				limit: 5,
			}
		);
	});

	it('leaves the band alone for a pin, or an id the band does not show', () => {
		const s = store({ conversations: [conversation(1)], limit: 5 });
		optimisticUnpin(s.store, { messageIds: ['m1'] as never, pinned: true });
		optimisticUnpin(s.store, { messageIds: ['m9'] as never, pinned: false });
		expect(s.setQuery).not.toHaveBeenCalled();
	});
});
