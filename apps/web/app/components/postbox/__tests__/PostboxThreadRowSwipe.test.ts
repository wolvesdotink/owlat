// @vitest-environment happy-dom
/**
 * PostboxThreadRow — swipe to triage (UX plan idea 21).
 *
 * The geometry is pinned in `utils/__tests__/postboxSwipe.test.ts`; what this
 * suite pins is the WIRING, which is where a gesture layer actually goes wrong:
 * a mouse drag that archives mail on a desktop, a vertical flick that triages
 * instead of scrolling, and a spring-back whose leftover click opens the message
 * the user just decided not to open.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_SWIPE_COMMIT_PX } from '~/utils/postboxSwipe';

import PostboxThreadRow, { type PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxSwipeTrack from '../PostboxSwipeTrack.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span :data-icon="name" />' };
const contextMenuStub = {
	props: ['items'],
	template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
};

const BASE: PostboxThreadRowMessage = {
	_id: 'msg-1' as Id<'mailMessages'>,
	fromAddress: 'ana@example.com',
	fromName: 'Ana',
	subject: 'Invoice for March',
	snippet: 'Attached, as agreed…',
	receivedAt: 1_700_000_000_000,
	flagSeen: false,
	flagFlagged: false,
	hasAttachments: false,
};

function mountRow(props: Partial<Record<'swipeLeft' | 'swipeRight', string>> = {}) {
	return mount(PostboxThreadRow, {
		props: {
			msg: BASE,
			folderRole: 'inbox',
			virtualize: false,
			selected: false,
			focused: false,
			active: false,
			swipeLeft: 'archive',
			swipeRight: 'snooze',
			...props,
		},
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxRowCore,
				PostboxSwipeTrack,
				Icon: iconStub,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: contextMenuStub,
				UiAvatar: { props: ['name', 'email', 'size'], template: '<span />' },
				PostboxThreadRowFollowUp: { template: '<span />' },
			},
			mocks: { formatThreadTimestamp: () => '2h', resolveComponent: () => 'a' },
		},
	});
}

/**
 * A pointer event with the fields the gesture layer reads. Built by hand rather
 * than through `trigger()` because `timeStamp` drives the velocity estimate and
 * is read-only on a constructed event.
 */
function pointer(
	type: string,
	init: { x: number; y: number; t: number; pointerType?: string; id?: number }
): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: init.x },
		clientY: { value: init.y },
		pointerType: { value: init.pointerType ?? 'touch' },
		pointerId: { value: init.id ?? 1 },
		isPrimary: { value: true },
		timeStamp: { value: init.t },
	});
	return event;
}

/** Drag from the row's origin to `x`/`y`, in a few steps, then lift. */
async function drag(
	row: Element,
	to: { x: number; y: number },
	opts: { pointerType?: string; steps?: number; ms?: number; release?: boolean } = {}
) {
	const steps = opts.steps ?? 4;
	const ms = opts.ms ?? 400;
	row.dispatchEvent(pointer('pointerdown', { x: 0, y: 0, t: 0, pointerType: opts.pointerType }));
	for (let i = 1; i <= steps; i++) {
		row.dispatchEvent(
			pointer('pointermove', {
				x: (to.x * i) / steps,
				y: (to.y * i) / steps,
				t: (ms * i) / steps,
				pointerType: opts.pointerType,
			})
		);
	}
	if (opts.release !== false) {
		row.dispatchEvent(
			pointer('pointerup', { x: to.x, y: to.y, t: ms, pointerType: opts.pointerType })
		);
	}
	await nextTick();
}

const PAST_COMMIT = POSTBOX_SWIPE_COMMIT_PX + 20;

/**
 * The `<li>` the gesture handlers are bound to. The component's root is the
 * renderless context-menu slot, so `wrapper.element` is the fragment's parent
 * container and an event dispatched there would never reach the row.
 */
function rowEl(w: ReturnType<typeof mountRow>): Element {
	return w.find('.pbx-row-li').element;
}

describe('PostboxThreadRow swipe', () => {
	it('archives on a left drag past the commit distance', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: -PAST_COMMIT, y: 4 });
		expect(w.emitted('swipe')).toEqual([['archive']]);
	});

	it('fires the remapped verb for the other direction', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: PAST_COMMIT, y: -3 });
		expect(w.emitted('swipe')).toEqual([['snooze']]);
	});

	it('NEVER triages from a mouse drag', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: -PAST_COMMIT, y: 0 }, { pointerType: 'mouse' });
		expect(w.emitted('swipe')).toBeUndefined();
	});

	it('leaves a vertical flick to the list scroller', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: -6, y: -160 });
		expect(w.emitted('swipe')).toBeUndefined();
	});

	it('abandons a diagonal drag for good, even once it turns sideways', async () => {
		const w = mountRow();
		const row = rowEl(w);
		row.dispatchEvent(pointer('pointerdown', { x: 0, y: 0, t: 0 }));
		// Starts as a scroll…
		row.dispatchEvent(pointer('pointermove', { x: -10, y: 40, t: 40 }));
		// …then swings hard left. The pointer is already spoken for.
		row.dispatchEvent(pointer('pointermove', { x: -200, y: 42, t: 120 }));
		row.dispatchEvent(pointer('pointerup', { x: -200, y: 42, t: 130 }));
		await nextTick();
		expect(w.emitted('swipe')).toBeUndefined();
	});

	it('springs back from a short drag without firing anything', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: -40, y: 2 }, { ms: 600 });
		expect(w.emitted('swipe')).toBeUndefined();
	});

	it('swallows the click a sprung-back drag leaves behind', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: -40, y: 2 }, { ms: 600 });
		const click = new MouseEvent('click', { bubbles: true, cancelable: true });
		rowEl(w).dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		// One gesture swallows exactly one click — the next tap must open the row.
		const second = new MouseEvent('click', { bubbles: true, cancelable: true });
		rowEl(w).dispatchEvent(second);
		expect(second.defaultPrevented).toBe(false);
	});

	it('stays completely inert on a direction mapped to none', async () => {
		const w = mountRow({ swipeLeft: 'none' });
		await drag(rowEl(w), { x: -PAST_COMMIT, y: 0 }, { release: false });
		expect(w.find('.pbx-swipe-track').exists()).toBe(false);
		rowEl(w).dispatchEvent(pointer('pointerup', { x: -PAST_COMMIT, y: 0, t: 400 }));
		await nextTick();
		expect(w.emitted('swipe')).toBeUndefined();
	});

	it('names the pending verb on the reveal track while the finger is down', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: -50, y: 0 }, { release: false });
		const track = w.find('.pbx-swipe-track');
		expect(track.exists()).toBe(true);
		expect(track.text()).toBe('Archive');
		// Under the commit distance the track is not yet armed.
		expect(track.classes()).toContain('bg-brand/10');
		expect(w.find('.pbx-row-link').attributes('style')).toContain('translate3d(-50px');
	});

	it('arms the track once releasing would fire the verb', async () => {
		const w = mountRow();
		await drag(rowEl(w), { x: PAST_COMMIT, y: 0 }, { release: false });
		const track = w.find('.pbx-swipe-track');
		expect(track.text()).toBe('Snooze');
		expect(track.classes()).toContain('bg-warning/25');
	});
});
