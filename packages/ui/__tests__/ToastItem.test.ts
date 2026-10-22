// @vitest-environment happy-dom
/**
 * THE CARD NAMES WHAT WAS PRESSED, NOT WHAT HAPPENS NEXT (#1442).
 *
 * A toast card has two buttons. The inline action ("Undo") emits `action`:
 * whether the toast goes is the stack's call, and an observed action keeps it
 * up while it runs, so calling that event `dismiss` described the one button
 * that often does not dismiss. The close button emits `close` and always takes
 * the toast. Each button emits exactly its own event, so a listener cannot be
 * wired to the wrong one by name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ToastItem from '../components/ui/ToastItem.vue';
import type { Toast } from '../composables/useToast';
import { mountUi, type MountedUi } from './i18n';

let mounted: MountedUi | null = null;

afterEach(() => {
	mounted?.unmount();
	mounted = null;
});

function renderCard(toast: Toast) {
	const listeners = { onAction: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
	mounted = mountUi(ToastItem, { toast, ...listeners });
	const buttons = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')];
	const close = buttons.find((b) => b.getAttribute('aria-label') === 'Dismiss notification');
	const action = buttons.find((b) => b !== close);
	return { ...listeners, action, close };
}

describe('ToastItem events', () => {
	it('emits `action` (never `dismiss` or `close`) when the action is pressed', async () => {
		const onToastAction = vi.fn();
		const card = renderCard({
			id: 'toast-1',
			message: 'Archived',
			type: 'success',
			action: { label: 'Undo', onAction: onToastAction },
		});
		expect(card.action?.textContent?.trim()).toBe('Undo');
		card.action!.click();
		await nextTick();
		expect(onToastAction).toHaveBeenCalledTimes(1);
		expect(card.onAction).toHaveBeenCalledTimes(1);
		expect(card.onDismiss).not.toHaveBeenCalled();
		expect(card.onClose).not.toHaveBeenCalled();
	});

	it('emits only `close` when the close button is pressed', async () => {
		const onToastAction = vi.fn();
		const card = renderCard({
			id: 'toast-2',
			message: 'Moved to Later',
			type: 'success',
			action: { label: 'Undoing…', onAction: onToastAction },
			pending: true,
		});
		card.close!.click();
		await nextTick();
		expect(card.onClose).toHaveBeenCalledTimes(1);
		expect(card.onAction).not.toHaveBeenCalled();
		expect(card.onDismiss).not.toHaveBeenCalled();
		expect(onToastAction).not.toHaveBeenCalled();
	});
});

describe('ToastItem keyboard hint', () => {
	it('follows the message with the hint, hidden on touch screens', () => {
		renderCard({
			id: 'toast-3',
			message: 'Archived',
			type: 'success',
			shortcutHint: 'Ctrl+Z to undo',
			action: { label: 'Undo', onAction: vi.fn() },
		});
		const message = mounted!.el.querySelector('p')!;
		expect(message.textContent?.replace(/\s+/g, ' ').trim()).toBe('Archived · Ctrl+Z to undo');
		expect(message.querySelector('span')?.className).toContain('pointer-coarse:hidden');
	});

	it('shows the message alone without one', () => {
		renderCard({ id: 'toast-4', message: 'Archived', type: 'success' });
		expect(mounted!.el.querySelector('p')!.textContent?.trim()).toBe('Archived');
	});
});

describe('ToastItem lookup', () => {
	it('carries its toast id, and its first button is the action', () => {
		renderCard({
			id: 'toast-5',
			message: 'Saving is taking longer than usual',
			type: 'warning',
			action: { label: 'Details', onAction: vi.fn() },
		});
		// A caller hands focus back to its own toast's action by these two facts.
		const card = mounted!.el.querySelector<HTMLElement>('[data-toast-id]')!;
		expect(card.dataset['toastId']).toBe('toast-5');
		expect(card.querySelector('button')?.textContent?.trim()).toBe('Details');
	});
});
