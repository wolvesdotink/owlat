// @vitest-environment happy-dom
/**
 * THE TOAST CARD WAITS FOR AN OBSERVED ACTION.
 *
 * The store contract is pinned in `composables/__tests__/useToast.test.ts`;
 * this is the same flow through the rendered stack, the way a pointer meets
 * it: press the action, see it pending, press again to no effect, and see the
 * outcome. A plain action still takes its toast with it on press.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Toast from '../components/ui/Toast.vue';
import { useToast } from '../composables/useToast';
import { mountUi, type MountedUi } from './i18n';

let mounted: MountedUi | null = null;

afterEach(() => {
	useToast().clearToasts();
	mounted?.unmount();
	mounted = null;
});

function card(text: string): HTMLElement | undefined {
	return [...document.querySelectorAll<HTMLElement>('[aria-live] > div')].find((c) =>
		c.textContent?.includes(text)
	);
}

/** What the stack holds; a removed card may still be in its leave transition. */
function messages(): string[] {
	return useToast().toasts.value.map((t) => t.message);
}

function button(within: HTMLElement | undefined, name: string): HTMLButtonElement | undefined {
	return [...(within?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
		(b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name
	);
}

async function renderObserved(run: () => Promise<boolean>) {
	mounted = mountUi(Toast);
	useToast().showToast('Moved to Later', 'success', {
		durationMs: 0,
		observedAction: { label: 'Undo', pendingLabel: 'Undoing…', failedNote: 'Not undone.', run },
	});
	await nextTick();
}

describe('Toast card with an observed action', () => {
	it('stays up and shows progress while the action runs, ignoring a second press', async () => {
		let finish!: (ok: boolean) => void;
		const run = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
		await renderObserved(run);

		button(card('Moved to Later'), 'Undo')!.click();
		await nextTick();
		const pending = card('Moved to Later');
		expect(pending).toBeDefined();
		const action = button(pending, 'Undoing…');
		expect(action).toBeDefined();
		expect(action!.classList.contains('pointer-events-none')).toBe(true);
		expect(pending!.querySelector('i')?.classList.contains('animate-spin')).toBe(true);

		action!.click();
		await nextTick();
		expect(run).toHaveBeenCalledTimes(1);

		finish(true);
		await vi.waitFor(() => expect(messages()).toEqual([]));
	});

	it('marks a failed action as not done and offers nothing to press again', async () => {
		await renderObserved(async () => false);
		button(card('Moved to Later'), 'Undo')!.click();
		await vi.waitFor(() => expect(card('Not undone.')).toBeDefined());
		const failed = card('Not undone.')!;
		expect(failed.textContent).toContain('Moved to Later. Not undone.');
		expect(button(failed, 'Undo')).toBeUndefined();
		expect(button(failed, 'Undoing…')).toBeUndefined();
		expect(failed.className).toContain('bg-warning-subtle');
	});

	it('closes a pending toast from its close button', async () => {
		await renderObserved(() => new Promise<boolean>(() => {}));
		button(card('Moved to Later'), 'Undo')!.click();
		await nextTick();
		button(card('Moved to Later'), 'Dismiss notification')!.click();
		await nextTick();
		expect(messages()).toEqual([]);
	});

	it('still dismisses a plain action toast on press', async () => {
		mounted = mountUi(Toast);
		const onAction = vi.fn();
		useToast().showToast('Archived', 'success', {
			durationMs: 0,
			action: { label: 'Undo', onAction },
		});
		await nextTick();
		button(card('Archived'), 'Undo')!.click();
		await nextTick();
		expect(onAction).toHaveBeenCalledTimes(1);
		expect(messages()).toEqual([]);
	});
});
