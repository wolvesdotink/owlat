import { afterEach, describe, expect, it } from 'vitest';
import { useMetaHold } from '../useMetaHold';

function key(k: string): KeyboardEvent {
	return { key: k } as KeyboardEvent;
}

/**
 * Force useDesktopContext's platform detection: it treats the runtime as macOS
 * only when the Tauri global is present AND navigator.platform matches /Mac/.
 * Toggling both lets us exercise the Meta (mac) vs Control (win/linux) branches.
 */
function setPlatform(kind: 'mac' | 'other'): void {
	const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
	w.__TAURI_INTERNALS__ = {};
	Object.defineProperty(navigator, 'platform', {
		value: kind === 'mac' ? 'MacIntel' : 'Win32',
		configurable: true,
	});
}

afterEach(() => {
	const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
	delete w.__TAURI_INTERNALS__;
});

describe('useMetaHold', () => {
	it('reveals while Meta is held and hides on release (macOS)', () => {
		setPlatform('mac');
		const { held, onKeydown, onKeyup } = useMetaHold();
		expect(held.value).toBe(false);

		onKeydown(key('Meta'));
		expect(held.value).toBe(true);

		// Repeated keydown (auto-repeat) keeps it held, not toggled.
		onKeydown(key('Meta'));
		expect(held.value).toBe(true);

		onKeyup(key('Meta'));
		expect(held.value).toBe(false);
	});

	it('tracks Control instead of Meta on Windows/Linux', () => {
		setPlatform('other');
		const { held, onKeydown, onKeyup } = useMetaHold();

		// Meta is the wrong modifier off macOS — ignored.
		onKeydown(key('Meta'));
		expect(held.value).toBe(false);

		onKeydown(key('Control'));
		expect(held.value).toBe(true);
		onKeyup(key('Control'));
		expect(held.value).toBe(false);
	});

	it('ignores unrelated keys', () => {
		setPlatform('mac');
		const { held, onKeydown, onKeyup } = useMetaHold();
		onKeydown(key('a'));
		expect(held.value).toBe(false);

		onKeydown(key('Meta'));
		onKeyup(key('Shift'));
		expect(held.value).toBe(true);
	});

	it('reset clears a stuck hold (e.g. window blur after ⌘/Ctrl-Tab)', () => {
		setPlatform('mac');
		const { held, onKeydown, reset } = useMetaHold();
		onKeydown(key('Meta'));
		expect(held.value).toBe(true);
		reset();
		expect(held.value).toBe(false);
	});
});
