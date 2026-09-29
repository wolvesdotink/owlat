// @vitest-environment happy-dom
/**
 * The countdown toast behind every undo window (mail send, campaign send,
 * review approve). It owns the parts the three toasts used to copy and let
 * drift: the countdown, the auto-dismiss, the busy guard that stops a double
 * click from running the reversal twice, the status role, and landing in the
 * layout's shared region instead of a fixed spot of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import UndoCountdownToast from '../UndoCountdownToast.vue';
import { UNDO_TOAST_REGION_ID } from '~/utils/undoToastRegion';

let region: HTMLElement;
let wrapper: VueWrapper | undefined;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-03-10T09:00:00Z'));
	region = document.createElement('div');
	region.id = UNDO_TOAST_REGION_ID;
	document.body.appendChild(region);
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
	region.remove();
	vi.useRealTimers();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function mountToast(props: Partial<Record<string, unknown>> = {}) {
	wrapper = mount(UndoCountdownToast, {
		props: {
			visible: true,
			sendAt: Date.now() + 10_000,
			icon: 'lucide:send',
			message: (seconds: number) => `Sending in ${seconds}s`,
			undoLabel: 'Undo',
			onUndo: () => {},
			...props,
		},
	});
	// The Teleport is deferred: it resolves its target after the mount flush.
	await nextTick();
	return wrapper;
}

const toast = () => region.querySelector<HTMLElement>('[role="status"]');
const undoButton = () => region.querySelector<HTMLButtonElement>('button');

describe('UiUndoCountdownToast', () => {
	it('renders into the shared undo region as a polite status', async () => {
		await mountToast();

		expect(toast()).not.toBeNull();
		expect(toast()!.getAttribute('aria-live')).toBe('polite');
		expect(toast()!.textContent).toContain('Sending in 10s');
		expect(undoButton()!.textContent!.trim()).toBe('Undo');
	});

	it('renders nothing while the window is closed', async () => {
		await mountToast({ visible: false });
		expect(toast()).toBeNull();
	});

	it('counts down to sendAt and hands the seconds to a function label', async () => {
		await mountToast({ undoLabel: (seconds: number) => `Undo (${seconds}s)` });
		expect(undoButton()!.textContent!.trim()).toBe('Undo (10s)');

		vi.advanceTimersByTime(4_000);
		await nextTick();
		expect(toast()!.textContent).toContain('Sending in 6s');
		expect(undoButton()!.textContent!.trim()).toBe('Undo (6s)');
	});

	it('emits expire once the window reaches zero, and hides', async () => {
		const w = await mountToast({ sendAt: Date.now() + 1_000 });
		expect(w.emitted('expire')).toBeUndefined();

		vi.advanceTimersByTime(1_000);
		await nextTick();
		expect(w.emitted('expire')).toHaveLength(1);
		expect(toast()).toBeNull();
	});

	it('does not expire a closed window', async () => {
		const w = await mountToast({ visible: false, sendAt: Date.now() + 1_000 });
		vi.advanceTimersByTime(2_000);
		await nextTick();
		expect(w.emitted('expire')).toBeUndefined();
	});

	it('disables Undo while the reversal runs, and a double click runs it once', async () => {
		const gate = deferred();
		const onUndo = vi.fn(() => gate.promise);
		await mountToast({ onUndo });

		undoButton()!.click();
		undoButton()!.click();
		await nextTick();
		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(undoButton()!.disabled).toBe(true);

		gate.resolve();
		await flushPromises();
		expect(undoButton()!.disabled).toBe(false);
	});
});
