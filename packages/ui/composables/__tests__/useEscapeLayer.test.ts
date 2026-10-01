import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { useEscapeLayer } from '../useEscapeLayer';

const scopes: EffectScope[] = [];

function layer(onEscape?: () => void, initiallyOpen = true) {
	const open = ref(initiallyOpen);
	const scope = effectScope();
	scope.run(() => useEscapeLayer(open, onEscape));
	scopes.push(scope);
	return { open, scope };
}

function press(init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', {
		key: 'Escape',
		bubbles: true,
		cancelable: true,
		...init,
	});
	document.body.dispatchEvent(event);
	return event;
}

afterEach(() => {
	for (const scope of scopes.splice(0)) scope.stop();
});

describe('useEscapeLayer', () => {
	it('gives Escape to the layer that opened last, whatever registered first', async () => {
		// A capture listener on the document, as an older dialog would have used.
		const documentCapture = vi.fn();
		document.addEventListener('keydown', documentCapture, true);
		try {
			const outer = vi.fn();
			const inner = vi.fn();
			layer(outer);
			const menu = layer(inner, false);
			menu.open.value = true;
			await nextTick();

			const event = press();
			expect(event.defaultPrevented).toBe(true);
			expect(inner).toHaveBeenCalledTimes(1);
			expect(outer).not.toHaveBeenCalled();
			expect(documentCapture).not.toHaveBeenCalled();

			menu.open.value = false;
			await nextTick();
			press();
			expect(outer).toHaveBeenCalledTimes(1);
		} finally {
			document.removeEventListener('keydown', documentCapture, true);
		}
	});

	it('lets the press through when the top layer has no handler, without reaching the one below', () => {
		const outer = vi.fn();
		layer(outer);
		layer();

		const event = press();
		expect(event.defaultPrevented).toBe(false);
		expect(outer).not.toHaveBeenCalled();
	});

	it('ignores other keys, IME composition and a press an earlier listener claimed', () => {
		let claiming = false;
		const claim = (event: KeyboardEvent) => claiming && event.preventDefault();
		// Ahead of the layer's own listener, like a window handler mounted earlier.
		window.addEventListener('keydown', claim, true);
		try {
			const onEscape = vi.fn();
			layer(onEscape);

			press({ key: 'Enter' });
			press({ isComposing: true });
			claiming = true;
			press();
			expect(onEscape).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener('keydown', claim, true);
		}
	});

	it('leaves Escape to the page once every layer is closed or disposed', async () => {
		const pageShortcut = vi.fn();
		window.addEventListener('keydown', pageShortcut);
		try {
			const onEscape = vi.fn();
			const dialog = layer(onEscape);
			const menu = layer(onEscape);
			menu.open.value = false;
			dialog.scope.stop();
			await nextTick();

			press();
			expect(onEscape).not.toHaveBeenCalled();
			expect(pageShortcut).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener('keydown', pageShortcut);
		}
	});
});
