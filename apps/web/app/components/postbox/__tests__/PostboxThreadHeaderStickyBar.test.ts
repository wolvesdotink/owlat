/**
 * The header line hands its sticky stand-in what the bar shows: the latest
 * sender (whom Reply answers), the newest list unsubscribe in the
 * conversation, and the same ⋯ menu, whose verbs reach the reader the way the
 * header's own do.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadHeader from '../PostboxThreadHeader.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useClickOutside', () => {});
});

/** The bar with its props and the header's slots on show. */
const stickyBar = defineComponent({
	name: 'PostboxReaderStickyBar',
	props: { subject: String, sender: String, header: { type: null, required: true } },
	emits: ['reply', 'archive'],
	setup:
		(props, { slots }) =>
		() =>
			h('div', { 'data-testid': 'sticky-bar', 'data-sender': props.sender }, [
				slots['lead']?.(),
				slots['default']?.(),
			]),
});
const unsubscribeChip = defineComponent({
	name: 'PostboxUnsubscribeChip',
	props: { messageId: String },
	inheritAttrs: false,
	setup: (props) => () =>
		h('div', { 'data-testid': 'unsubscribe', 'data-message-id': props.messageId }),
});
/** The ⋯ menu with its items always rendered (the real one opens on click). */
const overflowMenu = defineComponent({
	name: 'PostboxOverflowMenu',
	setup:
		(_p, { slots }) =>
		() =>
			h('div', slots['default']?.({ close: () => {} })),
});

type Message = {
	_id: string;
	fromAddress: string;
	fromName?: string;
	unsubscribe?: { httpUrl?: string; oneClick?: boolean };
};

function mountHeader(messages: Message[]) {
	return mount(PostboxThreadHeader, {
		props: {
			subject: 'Northwind digest',
			messageCount: messages.length,
			messageId: 'm1' as never,
			messages,
			mailboxId: 'mbx1',
			showWhyHere: true,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxReaderStickyBar: stickyBar,
				PostboxUnsubscribeChip: unsubscribeChip,
				PostboxOverflowMenu: overflowMenu,
			},
		},
	});
}

describe('the header line and its sticky bar', () => {
	it('names the latest sender and offers the newest list unsubscribe', () => {
		const w = mountHeader([
			{
				_id: 'm0',
				fromName: 'Northwind News',
				fromAddress: 'news@northwind.example',
				unsubscribe: { httpUrl: 'https://northwind.example/u', oneClick: true },
			},
			{ _id: 'm1', fromName: 'Ines Weber', fromAddress: 'ines@example.com' },
		]);
		const bar = w.get('[data-testid="sticky-bar"]');
		expect(bar.attributes('data-sender')).toBe('Ines Weber');
		expect(
			bar.findAll('[data-testid="unsubscribe"]').map((c) => c.attributes('data-message-id'))
		).toEqual(['m0']);
	});

	it('offers no unsubscribe when no message came from a list', () => {
		const w = mountHeader([{ _id: 'm1', fromAddress: 'ines@example.com' }]);
		const bar = w.get('[data-testid="sticky-bar"]');
		expect(bar.attributes('data-sender')).toBe('ines@example.com');
		expect(bar.find('[data-testid="unsubscribe"]').exists()).toBe(false);
	});

	it("the bar's ⋯ menu and verbs reach the reader like the header's", async () => {
		const w = mountHeader([{ _id: 'm1', fromAddress: 'ines@example.com' }]);
		const bar = w.get('[data-testid="sticky-bar"]');
		await bar.get('[data-testid="thread-menu-details"]').trigger('click');
		await bar.get('[data-testid="thread-menu-snooze"]').trigger('click');
		await bar.get('[data-testid="thread-menu-why-here"]').trigger('click');
		w.getComponent(stickyBar).vm.$emit('reply');
		expect(w.emitted('details')).toHaveLength(1);
		expect(w.emitted('snooze')).toHaveLength(1);
		expect(w.emitted('reply')).toHaveLength(1);
		// "Why is this here?" anchors on the bar it was opened from.
		expect(w.emitted('why-here')?.[0]).toEqual([bar.element]);
	});
});
