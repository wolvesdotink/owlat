import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useWorkbenchKeyboard } from '../useWorkbenchKeyboard';
import type { TodayLine } from '~/utils/todayDigest';
import {
	applyShortcutPreferences,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';

/**
 * The Workbench's keys are catalog ids in the `workbench` scope, dispatched by
 * the app-wide dispatcher on the document, so a remap moves them and a
 * half-typed `g` chord is never mistaken for one of them.
 */
let wrapper: VueWrapper | null = null;
beforeEach(() => {
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	resetShortcutScopes();
	resetShortcutPreferences();
});
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function line(key: string, inboundMessageId: string | null = null): TodayLine {
	return {
		key,
		lead: 'Harbor Design',
		text: key,
		isSummary: false,
		sources: [],
		inboxId: 'team',
		reason: null,
		at: 0,
		inboundMessageId,
	};
}

function mountHost(lines: TodayLine[], peekOpen = false) {
	const actions = { open: vi.fn(), done: vi.fn(), replyAnyway: vi.fn() };
	const Host = defineComponent({
		setup() {
			useWorkbenchKeyboard({ lines: () => lines, peekOpen: () => peekOpen, ...actions });
			return () =>
				h(
					'div',
					lines.map((l) => h('button', { 'data-today-key': l.key }, l.text))
				);
		},
	});
	wrapper = mount(Host, { attachTo: document.body });
	return actions;
}

function press(key: string) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
}
const focused = () => (document.activeElement as HTMLElement | null)?.dataset['todayKey'];

describe('useWorkbenchKeyboard', () => {
	it('moves focus between lines with j and k', () => {
		mountHost([line('a'), line('b'), line('c')]);
		press('j');
		expect(focused()).toBe('a');
		press('j');
		press('j');
		press('j');
		expect(focused()).toBe('c');
		press('k');
		expect(focused()).toBe('b');
	});

	it('opens, marks done and replies on the focused line', () => {
		const lines = [line('a'), line('b', 'msg_1')];
		const actions = mountHost(lines);
		press('j');
		press('Enter');
		expect(actions.open).toHaveBeenCalledWith(lines[0]);
		press('d');
		expect(actions.done).toHaveBeenCalledWith(lines[0]);
		expect(focused()).toBe('b');
		press('r');
		expect(actions.replyAnyway).toHaveBeenCalledWith(lines[1]);
	});

	it('does not reply on a line without a team-inbox message', () => {
		const actions = mountHost([line('a')]);
		press('j');
		press('r');
		expect(actions.replyAnyway).not.toHaveBeenCalled();
	});

	it('leaves the keys to the peek panel while it is open', () => {
		const actions = mountHost([line('a')], true);
		press('j');
		press('Enter');
		expect(focused()).toBeUndefined();
		expect(actions.open).not.toHaveBeenCalled();
	});

	it('leaves a key it cannot act on unclaimed', () => {
		mountHost([line('a')]);
		// Nothing is focused, so there is no line to open or mark done.
		expect(press('Enter').defaultPrevented).toBe(false);
		expect(press('d').defaultPrevented).toBe(false);
		expect(press('j').defaultPrevented).toBe(true);
	});

	it('follows a remap: the new key moves, the old one no longer does', () => {
		applyShortcutPreferences('owlat', [{ id: 'workbench.next', keys: ['n'] }]);
		mountHost([line('a'), line('b')]);
		press('j');
		expect(focused()).toBeUndefined();
		press('n');
		expect(focused()).toBe('a');
		press('n');
		expect(focused()).toBe('b');
	});

	it('does not mark a line done on the second key of a `g d` chord', () => {
		const lines = [line('a'), line('b')];
		const actions = mountHost(lines);
		press('j');
		press('g');
		press('d');
		expect(actions.done).not.toHaveBeenCalled();
	});
});
