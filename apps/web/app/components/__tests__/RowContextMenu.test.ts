/**
 * RowContextMenu — the one join between a row, the shared context menu and the
 * row gesture stream, which every list row with a menu now goes through
 * (Team Inbox, automations, Today, the sidebar).
 *
 *   - right-click opens the menu with the row's verbs
 *   - a touch hold opens the same menu at the touch point (fake clock), and the
 *     click the finger-lift leaves behind does not follow the row's link
 *   - a vertical drag is a scroll: no menu, no swipe, and the link still works
 *   - a mouse press never starts a hold
 *   - a row with swipe verbs emits the committed one; a row without never
 *     claims a horizontal drag
 *   - Shift+click emits `shift-click` instead of following the link, only for
 *     rows that ask for it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import RowContextMenu from '../RowContextMenu.vue';
import PostboxSwipeTrack from '../postbox/PostboxSwipeTrack.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_SWIPE_COMMIT_PX, type RowSwipeAction } from '~/utils/postboxSwipe';

vi.stubGlobal('useI18n', i18nStubs.useI18n);

const Icon = defineComponent({ name: 'Icon', props: ['name'], template: '<i />' });

const Harness = defineComponent({
	props: {
		items: { type: Array as PropType<ContextMenuItem[]>, required: true },
		swipeLeft: { type: String as PropType<RowSwipeAction>, default: undefined },
		swipeRight: { type: String as PropType<RowSwipeAction>, default: undefined },
		shiftClickSelects: { type: Boolean, default: false },
		onFollow: { type: Function as PropType<() => void>, required: true },
	},
	emits: ['swipe', 'shift-click'],
	setup(props, { emit }) {
		return () =>
			h(
				RowContextMenu,
				{
					items: props.items,
					swipeLeft: props.swipeLeft,
					swipeRight: props.swipeRight,
					shiftClickSelects: props.shiftClickSelects,
					onSwipe: (action: string) => emit('swipe', action),
					onShiftClick: () => emit('shift-click'),
				},
				{
					default: ({ rowBindings, track }: { rowBindings: object; track: unknown }) =>
						h('li', { class: 'row', ...rowBindings }, [
							track ? h(PostboxSwipeTrack, { track }) : null,
							h(
								'a',
								{
									href: '/row',
									class: 'link',
									onClick: (event: MouseEvent) => {
										event.preventDefault();
										props.onFollow();
									},
								},
								'Row'
							),
						]),
				}
			);
	},
});

function pointer(
	type: string,
	init: { x: number; y: number; t?: number; pointerType?: string }
): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: init.x },
		clientY: { value: init.y },
		pointerType: { value: init.pointerType ?? 'touch' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		timeStamp: { value: init.t ?? 0 },
	});
	return event;
}

const run = vi.fn();
const follow = vi.fn();
const ITEMS: ContextMenuItem[] = [
	{ id: 'resolve', label: 'Resolve', shortcut: 'E', run },
	{ id: 'open', label: 'Open', run: () => {} },
];

function mountRow(props: Record<string, unknown> = {}) {
	const wrapper = mount(Harness, {
		props: { items: ITEMS, onFollow: follow, ...props },
		attachTo: document.body,
		global: { plugins: [createTestI18n()], components: { Icon } },
	});
	// Vue drops an event stamped no later than its listener was attached; with
	// the clock frozen, a click right after mounting would be exactly that.
	vi.advanceTimersByTime(1);
	return wrapper;
}

const menu = () => document.body.querySelector('[role="menu"]');
const labels = () =>
	Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((el) =>
		el.textContent!.trim()
	);

beforeEach(() => {
	vi.useFakeTimers();
	run.mockClear();
	follow.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
});

describe('RowContextMenu', () => {
	it('opens on right-click with the row’s verbs and their keys', async () => {
		const wrapper = mountRow();
		await wrapper.get('.row').trigger('contextmenu', { clientX: 10, clientY: 10 });
		expect(labels()).toEqual(['ResolveE', 'Open']);
		wrapper.unmount();
	});

	it('opens on a touch hold and swallows the click the lift leaves behind', async () => {
		const wrapper = mountRow();
		const row = wrapper.get('.row').element;
		row.dispatchEvent(pointer('pointerdown', { x: 30, y: 40 }));
		vi.advanceTimersByTime(499);
		await nextTick();
		expect(menu()).toBeNull();
		vi.advanceTimersByTime(1);
		await nextTick();
		expect(menu()).not.toBeNull();
		row.dispatchEvent(pointer('pointerup', { x: 30, y: 40 }));
		wrapper.get('.link').element.click();
		expect(follow).not.toHaveBeenCalled();
		// One click per gesture: the next tap opens the row again.
		row.dispatchEvent(pointer('pointerdown', { x: 30, y: 40 }));
		row.dispatchEvent(pointer('pointerup', { x: 30, y: 40 }));
		wrapper.get('.link').element.click();
		expect(follow).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('treats a vertical drag as a scroll: no menu, and the link still follows', async () => {
		const wrapper = mountRow({ swipeLeft: 'resolve', swipeRight: 'snooze' });
		const row = wrapper.get('.row').element;
		row.dispatchEvent(pointer('pointerdown', { x: 30, y: 40 }));
		row.dispatchEvent(pointer('pointermove', { x: 31, y: 80, t: 50 }));
		vi.advanceTimersByTime(1000);
		row.dispatchEvent(pointer('pointerup', { x: 31, y: 80, t: 60 }));
		await nextTick();
		expect(menu()).toBeNull();
		expect(wrapper.emitted('swipe')).toBeUndefined();
		wrapper.get('.link').element.click();
		expect(follow).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('never starts a hold for a mouse', async () => {
		const wrapper = mountRow();
		const row = wrapper.get('.row').element;
		row.dispatchEvent(pointer('pointerdown', { x: 30, y: 40, pointerType: 'mouse' }));
		vi.advanceTimersByTime(1000);
		await nextTick();
		expect(menu()).toBeNull();
		wrapper.unmount();
	});

	it('emits the committed swipe verb and swallows its click', async () => {
		const wrapper = mountRow({ swipeLeft: 'resolve', swipeRight: 'snooze' });
		const row = wrapper.get('.row').element;
		const to = -(POSTBOX_SWIPE_COMMIT_PX + 10);
		row.dispatchEvent(pointer('pointerdown', { x: 200, y: 40, t: 0 }));
		for (let i = 1; i <= 4; i++) {
			row.dispatchEvent(pointer('pointermove', { x: 200 + (to * i) / 4, y: 40, t: i * 100 }));
		}
		await nextTick();
		expect(wrapper.find('.pbx-swipe-track').text()).toContain('Resolve');
		row.dispatchEvent(pointer('pointerup', { x: 200 + to, y: 40, t: 400 }));
		await nextTick();
		expect(wrapper.emitted('swipe')).toEqual([['resolve']]);
		wrapper.get('.link').element.click();
		expect(follow).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('never claims a horizontal drag without swipe verbs', async () => {
		const wrapper = mountRow();
		const row = wrapper.get('.row').element;
		row.dispatchEvent(pointer('pointerdown', { x: 200, y: 40, t: 0 }));
		row.dispatchEvent(pointer('pointermove', { x: 50, y: 40, t: 100 }));
		row.dispatchEvent(pointer('pointerup', { x: 50, y: 40, t: 200 }));
		await nextTick();
		expect(wrapper.find('.pbx-swipe-track').exists()).toBe(false);
		expect(wrapper.emitted('swipe')).toBeUndefined();
		wrapper.unmount();
	});

	it('turns Shift+click into shift-click only for rows that select', async () => {
		const selecting = mountRow({ shiftClickSelects: true });
		selecting
			.get('.link')
			.element.dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })
			);
		expect(selecting.emitted('shift-click')).toHaveLength(1);
		expect(follow).not.toHaveBeenCalled();
		selecting.unmount();

		const plain = mountRow();
		plain
			.get('.link')
			.element.dispatchEvent(
				new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })
			);
		expect(plain.emitted('shift-click')).toBeUndefined();
		expect(follow).toHaveBeenCalledTimes(1);
		plain.unmount();
	});
});
