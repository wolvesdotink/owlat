// @vitest-environment happy-dom
/**
 * "Full brief" from the header's ⋯ menu by keyboard (read on arrival §3): the
 * menu item unmounts as the sheet opens, so the sheet must remember the ⋯
 * trigger as its opener, and closing it puts focus back there, never on
 * <body>. Real header, real overflow menu, and a sheet built on the same
 * useModalFocus as PostboxBriefSheet.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadHeader from '../PostboxThreadHeader.vue';
import PostboxOverflowMenu from '../PostboxOverflowMenu.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useClickOutside', () => {});
});

const sheet = defineComponent({
	props: { open: { type: Boolean, required: true } },
	emits: ['close'],
	setup(props, { emit }) {
		const el = ref<HTMLElement | null>(null);
		useModalFocus(
			el,
			() => props.open,
			() => emit('close')
		);
		return () =>
			props.open
				? h('div', { ref: el, role: 'dialog', tabindex: -1, 'data-testid': 'sheet' }, [
						h('button', { 'data-testid': 'sheet-close', onClick: () => emit('close') }, 'Close'),
					])
				: null;
	},
});

const host = defineComponent({
	setup() {
		const isOpen = ref(false);
		return () =>
			h('div', [
				h(PostboxThreadHeader, {
					subject: 'Print run',
					messageCount: 1,
					messageId: 'm1' as never,
					showFullBrief: true,
					onFullBrief: () => (isOpen.value = true),
				}),
				h(sheet, { open: isOpen.value, onClose: () => (isOpen.value = false) }),
			]);
	},
});

const mounted: VueWrapper[] = [];
afterEach(() => {
	for (const w of mounted) w.unmount();
	mounted.length = 0;
});

describe('Full brief from the ⋯ menu', () => {
	it('returns focus to the ⋯ trigger when the sheet closes, after a keyboard open', async () => {
		const w = mount(host, {
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				components: { PostboxOverflowMenu },
				stubs: {
					Icon: true,
					UiButton: { template: '<button type="button"><slot /></button>' },
				},
			},
		});
		mounted.push(w);
		const trigger = w.get('button[aria-haspopup="menu"]');
		(trigger.element as HTMLElement).focus();
		await trigger.trigger('click');
		const item = w.get('[data-testid="thread-menu-full-brief"]');
		(item.element as HTMLElement).focus();
		expect(document.activeElement).toBe(item.element);
		// Enter on a focused button activates it as a click.
		(item.element as HTMLElement).click();
		await flushPromises();
		expect(w.find('[role="menu"]').exists()).toBe(false);
		expect(w.find('[data-testid="sheet"]').exists()).toBe(true);
		expect(document.activeElement).toBe(w.get('[data-testid="sheet-close"]').element);

		await w.get('[data-testid="sheet-close"]').trigger('click');
		await nextTick();
		expect(w.find('[data-testid="sheet"]').exists()).toBe(false);
		expect(document.activeElement).toBe(trigger.element);
		expect(document.activeElement).not.toBe(document.body);
	});

	it('Esc inside the open menu also hands focus back to the trigger', async () => {
		const w = mount(host, {
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				components: { PostboxOverflowMenu },
				stubs: {
					Icon: true,
					UiButton: { template: '<button type="button"><slot /></button>' },
				},
			},
		});
		mounted.push(w);
		const trigger = w.get('button[aria-haspopup="menu"]');
		await trigger.trigger('click');
		const item = w.get('[data-testid="thread-menu-full-brief"]').element as HTMLElement;
		item.focus();
		item.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		await nextTick();
		expect(w.find('[role="menu"]').exists()).toBe(false);
		expect(document.activeElement).toBe(trigger.element);
	});
});
