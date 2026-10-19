/**
 * ORDINARY TOASTS COUNT READING TIME; ACTION TOASTS KEEP THEIR DEADLINE.
 *
 * An ordinary notification (no action) used to expire on a one-shot timer, so
 * it could run out in a hidden tab, behind another desktop window or under the
 * pointer. Its `durationMs` is now a reading-time budget: paused while the card
 * is hovered or focused and while the page is hidden or unfocused, resumed with
 * what was left. What stays pinned:
 *
 *  - a visible, untouched ordinary toast still goes after exactly `durationMs`,
 *    and a sticky one (`0`, non-finite) still never does;
 *  - a toast with an action (or any other action-like option) expires at its
 *    current time even while hovered, focused, hidden or unfocused: pausing it
 *    would stretch the window in which its action may still run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Toast from '../../components/ui/Toast.vue';
import { useToast, type ToastOptions } from '../useToast';
import { isReadingTimeToast } from '../useToastReadingTime';
import { mountUi, type MountedUi } from '../../__tests__/i18n';

let hidden = false;
let focused = true;
let mounted: MountedUi | null = null;

function setHidden(value: boolean) {
	hidden = value;
	document.dispatchEvent(new Event('visibilitychange'));
}

function setWindowFocused(value: boolean) {
	focused = value;
	window.dispatchEvent(new FocusEvent(value ? 'focus' : 'blur'));
}

function messages(): string[] {
	return useToast().toasts.value.map((t) => t.message);
}

async function mountStack() {
	mounted = mountUi(Toast);
	await nextTick();
}

function card(message: string): HTMLElement {
	const found = [...document.querySelectorAll<HTMLElement>('[aria-live] > div')].find((el) =>
		el.textContent?.includes(message)
	);
	if (!found) throw new Error(`no toast card for "${message}"`);
	return found;
}

function hover(el: HTMLElement, pointerType = 'mouse') {
	el.dispatchEvent(new PointerEvent('pointerenter', { pointerType }));
}

function unhover(el: HTMLElement, pointerType = 'mouse') {
	el.dispatchEvent(new PointerEvent('pointerleave', { pointerType }));
}

const undo = () => ({ label: 'Undo', onAction: vi.fn() });

/**
 * How many page listeners (visibilitychange on the document, blur and focus on
 * the window) are attached right now, counted from the add/remove calls made
 * since `countPageListeners` was set up.
 */
function countPageListeners(): () => number {
	const events = new Set(['visibilitychange', 'blur', 'focus']);
	let active = 0;
	for (const target of [document, window]) {
		const add = target.addEventListener.bind(target);
		const remove = target.removeEventListener.bind(target);
		vi.spyOn(target, 'addEventListener').mockImplementation((type, ...rest) => {
			if (events.has(type)) active++;
			add(type, ...rest);
		});
		vi.spyOn(target, 'removeEventListener').mockImplementation((type, ...rest) => {
			if (events.has(type)) active--;
			remove(type, ...rest);
		});
	}
	return () => active;
}

beforeEach(() => {
	vi.useFakeTimers();
	hidden = false;
	focused = true;
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
	document.hasFocus = () => focused;
	useToast().clearToasts();
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	useToast().clearToasts();
	// clearToasts drops every budget; running the clock out is a backstop so a
	// test that breaks that cannot leak a budget into the next one.
	setHidden(false);
	setWindowFocused(true);
	vi.runAllTimers();
	vi.restoreAllMocks();
	delete (document as { hidden?: boolean }).hidden;
	delete (document as { hasFocus?: () => boolean }).hasFocus;
	vi.useRealTimers();
});

describe('ordinary toast reading time', () => {
	it('expires after exactly durationMs when visible and untouched', () => {
		const onDismiss = vi.fn();
		useToast().showToast('Saved', 'success', { durationMs: 5000, onDismiss });
		vi.advanceTimersByTime(4999);
		expect(messages()).toEqual(['Saved']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('keeps the per-type default durations', () => {
		useToast().showToast('Heads up', 'info');
		vi.advanceTimersByTime(3999);
		expect(messages()).toEqual(['Heads up']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('pauses while the document is hidden and resumes with the remaining time', () => {
		const onDismiss = vi.fn();
		useToast().showToast('Heads up', 'info', { onDismiss });
		vi.advanceTimersByTime(1000);

		setHidden(true);
		vi.advanceTimersByTime(60_000);
		expect(messages()).toEqual(['Heads up']);

		setHidden(false);
		vi.advanceTimersByTime(2999);
		expect(messages()).toEqual(['Heads up']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('does not start counting while it was shown into a hidden document', () => {
		setHidden(true);
		useToast().showToast('Imported 40 contacts', 'success', { durationMs: 3000 });
		vi.advanceTimersByTime(30_000);
		expect(messages()).toEqual(['Imported 40 contacts']);

		setHidden(false);
		vi.advanceTimersByTime(2999);
		expect(messages()).toEqual(['Imported 40 contacts']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('pauses while the window is unfocused although the document stays visible', () => {
		useToast().showToast('Signature updated', 'success', { durationMs: 3000 });
		vi.advanceTimersByTime(2000);

		setWindowFocused(false);
		vi.advanceTimersByTime(20_000);
		expect(messages()).toEqual(['Signature updated']);

		setWindowFocused(true);
		vi.advanceTimersByTime(999);
		expect(messages()).toEqual(['Signature updated']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('pauses while the card is hovered and resumes when the pointer leaves', async () => {
		await mountStack();
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		await nextTick();
		vi.advanceTimersByTime(1000);

		hover(card('Saved'));
		vi.advanceTimersByTime(10_000);
		expect(messages()).toEqual(['Saved']);

		unhover(card('Saved'));
		vi.advanceTimersByTime(1999);
		expect(messages()).toEqual(['Saved']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('does not treat a touch as hover', async () => {
		await mountStack();
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		await nextTick();
		hover(card('Saved'), 'touch');
		vi.advanceTimersByTime(3000);
		expect(messages()).toEqual([]);
	});

	it('pauses while focus is within the card and resumes when focus leaves', async () => {
		await mountStack();
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		await nextTick();
		const close = card('Saved').querySelector('button');
		if (!close) throw new Error('no close button');

		close.focus();
		vi.advanceTimersByTime(10_000);
		expect(messages()).toEqual(['Saved']);

		close.blur();
		vi.advanceTimersByTime(2999);
		expect(messages()).toEqual(['Saved']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('stays paused until every reason has cleared', async () => {
		await mountStack();
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		await nextTick();

		hover(card('Saved'));
		setHidden(true);
		vi.advanceTimersByTime(5000);
		setHidden(false);
		vi.advanceTimersByTime(5000);
		expect(messages()).toEqual(['Saved']);

		unhover(card('Saved'));
		vi.advanceTimersByTime(3000);
		expect(messages()).toEqual([]);
	});

	it('drops a hover hold when the card unmounts with the toast still listed', async () => {
		await mountStack();
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		await nextTick();
		hover(card('Saved'));
		vi.advanceTimersByTime(5000);

		mounted?.unmount();
		mounted = null;
		vi.advanceTimersByTime(3000);
		expect(messages()).toEqual([]);
	});

	it('leaves a sticky toast sticky', () => {
		useToast().showToast('Stay put', 'error', { durationMs: 0 });
		useToast().showToast('Forever', 'warning', { durationMs: Number.POSITIVE_INFINITY });
		setHidden(true);
		setHidden(false);
		vi.advanceTimersByTime(600_000);
		expect(messages()).toEqual(['Stay put', 'Forever']);
	});

	it('measures on the monotonic clock: a forward wall-clock jump does not cut it short', () => {
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		vi.advanceTimersByTime(1000);
		vi.setSystemTime(Date.now() + 60_000);
		setHidden(true);
		setHidden(false);
		vi.advanceTimersByTime(1999);
		expect(messages()).toEqual(['Saved']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('measures on the monotonic clock: a backward wall-clock jump does not stretch it', () => {
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		vi.advanceTimersByTime(1000);
		vi.setSystemTime(Date.now() - 60_000);
		setHidden(true);
		setHidden(false);
		vi.advanceTimersByTime(1999);
		expect(messages()).toEqual(['Saved']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('stops listening to the page once no budget is left', () => {
		const remove = vi.spyOn(document, 'removeEventListener');
		useToast().showToast('Saved', 'success', { durationMs: 1000 });
		vi.advanceTimersByTime(1000);
		expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
		remove.mockRestore();
	});
});

describe('a dismissed ordinary toast leaves nothing behind', () => {
	it('drops every budget and page listener when cleared while the page is hidden', () => {
		const listeners = countPageListeners();
		const onDismiss = vi.fn();
		useToast().showToast('Saved', 'success', { onDismiss });
		useToast().showToast('Heads up', 'info', { onDismiss });
		expect(listeners()).toBe(3);

		setHidden(true);
		useToast().clearToasts();
		expect(listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(onDismiss).toHaveBeenCalledTimes(2);

		setHidden(false);
		vi.advanceTimersByTime(60_000);
		expect(onDismiss).toHaveBeenCalledTimes(2);
	});

	it('cancels a running budget when the toast is closed', () => {
		const listeners = countPageListeners();
		const { showToast, removeToast } = useToast();
		const id = showToast('Saved', 'success', { durationMs: 3000 });
		expect(vi.getTimerCount()).toBe(1);

		removeToast(id);
		expect(vi.getTimerCount()).toBe(0);
		expect(listeners()).toBe(0);
	});

	it('cancels a budget whose toast is removed before its card renders', async () => {
		await mountStack();
		const listeners = countPageListeners();
		const { showToast, removeToast } = useToast();
		removeToast(showToast('Saved', 'success', { durationMs: 3000 }));
		await nextTick();
		expect(document.querySelectorAll('[aria-live] > div')).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(listeners()).toBe(0);
	});

	it('keeps the budget of a toast still listed when the stack unmounts', async () => {
		await mountStack();
		useToast().showToast('Saved', 'success', { durationMs: 3000 });
		await nextTick();
		mounted?.unmount();
		mounted = null;
		vi.advanceTimersByTime(2999);
		expect(messages()).toEqual(['Saved']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});
});

describe('action toasts keep their current deadline', () => {
	it('expires at durationMs while hovered, focused, hidden and unfocused', async () => {
		await mountStack();
		const onDismiss = vi.fn();
		useToast().showToast('Conversation archived', 'success', {
			durationMs: 5000,
			action: undo(),
			onDismiss,
		});
		await nextTick();

		hover(card('Conversation archived'));
		card('Conversation archived').querySelector('button')?.focus();
		setHidden(true);
		setWindowFocused(false);

		vi.advanceTimersByTime(4999);
		expect(messages()).toEqual(['Conversation archived']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('expires at the per-type default while the document is hidden', () => {
		useToast().showToast('Moved to trash', 'success', { action: undo() });
		setHidden(true);
		vi.advanceTimersByTime(2999);
		expect(messages()).toEqual(['Moved to trash']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});

	it('also holds for an action-like option this module does not know', () => {
		// The shape of the observed-action option: any option beyond the ordinary
		// ones keeps the one-shot timer, so it does not need to be named here.
		const options = {
			durationMs: 5000,
			observedAction: {
				label: 'Undo',
				pendingLabel: 'Undoing…',
				failedNote: 'Not undone.',
				run: async () => true,
			},
		} as unknown as ToastOptions;
		useToast().showToast('Sender learned', 'info', options);
		setHidden(true);
		setWindowFocused(false);
		vi.advanceTimersByTime(4999);
		expect(messages()).toEqual(['Sender learned']);
		vi.advanceTimersByTime(1);
		expect(messages()).toEqual([]);
	});
});

describe('isReadingTimeToast', () => {
	it('accepts no options and the ordinary ones', () => {
		expect(isReadingTimeToast(undefined)).toBe(true);
		expect(isReadingTimeToast({})).toBe(true);
		expect(isReadingTimeToast({ durationMs: 5000, onDismiss: () => {} })).toBe(true);
		expect(isReadingTimeToast({ action: undefined })).toBe(true);
	});

	it('rejects an action and any other option with a value', () => {
		expect(isReadingTimeToast({ action: undo() })).toBe(false);
		expect(isReadingTimeToast({ observedAction: { label: 'Undo' } })).toBe(false);
	});
});
