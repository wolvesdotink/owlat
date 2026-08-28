// @vitest-environment happy-dom
/**
 * THE APP-WIDE DISPATCHER, DRIVEN BY REAL KEY EVENTS.
 *
 * What broke before the registry was never a key map on its own — it was the
 * seams between five of them: a `g` chord hardcoded in one place, the surface
 * that wanted to reuse `g s` for something else, and a cheat sheet that
 * documented neither. So this suite works through `document.dispatchEvent`,
 * asserting what a keypress DOES under a given scope chain rather than what a
 * table contains.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import {
	applyShortcutPreferences,
	pushShortcutScope,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';

const push = vi.fn();

/**
 * Mounted, because the composable installs its listener in `onMounted` and the
 * registrations are module state that outlives any one component.
 */
function mountHost(register: (api: ReturnType<typeof useKeyboardShortcuts>) => void): VueWrapper {
	const Host = defineComponent({
		setup() {
			const api = useKeyboardShortcuts();
			registered = api;
			register(api);
			return () => null;
		},
	});
	return mount(Host);
}

function press(key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
	document.dispatchEvent(event);
	return event;
}

let wrapper: VueWrapper | null = null;
let registered: ReturnType<typeof useKeyboardShortcuts> | null = null;

beforeEach(() => {
	push.mockClear();
	vi.stubGlobal('useRouter', () => ({ push }));
	resetShortcutScopes();
	resetShortcutPreferences();
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	// Handler registrations are module state that outlives the component, so
	// clear the whole catalog rather than trusting each test to tidy up.
	for (const def of SHORTCUT_CATALOG) registered?.unregisterShortcut(def.id);
	registered = null;
	// NOT `vi.unstubAllGlobals()`: the shared setup file installs Vue's own
	// auto-imports as globals, and clearing them would unmount the harness.
});

describe('useKeyboardShortcuts — sequence chords', () => {
	beforeEach(() => {
		wrapper = mountHost((api) => {
			api.registerNavigationShortcuts();
		});
	});

	it('routes `g` then `d` to the dashboard', () => {
		press('g');
		press('d');
		expect(push).toHaveBeenCalledWith('/dashboard');
	});

	it('swallows the second key of an UNBOUND pair rather than leaking it', () => {
		press('g');
		const stray = press('q');
		expect(push).not.toHaveBeenCalled();
		// Consumed by the chord, not passed on as a single-key shortcut.
		expect(stray.defaultPrevented).toBe(false);
	});

	it('forgets a half-typed chord once its window closes', () => {
		vi.useFakeTimers();
		press('g');
		vi.advanceTimersByTime(600);
		press('d');
		expect(push).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it('stays inert while a text field has focus', () => {
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();
		press('g');
		press('d');
		expect(push).not.toHaveBeenCalled();
		input.remove();
	});

	it('never claims a Cmd/Ctrl/Alt chord — those belong to the browser', () => {
		press('g', { metaKey: true });
		press('d');
		expect(push).not.toHaveBeenCalled();
	});
});

describe('useKeyboardShortcuts — scoping', () => {
	it('gives a chord to the surface that claimed the keyboard', async () => {
		const postbox = vi.fn();
		wrapper = mountHost((api) => {
			api.registerNavigationShortcuts();
			api.registerShortcut({ id: 'postbox.goStarred', handler: postbox, ignoreInputs: true });
		});
		await nextTick();

		// Global first: `g s` is the admin area.
		press('g');
		press('s');
		expect(push).toHaveBeenCalledWith('/dashboard/admin');
		expect(postbox).not.toHaveBeenCalled();

		const release = pushShortcutScope('postbox');
		push.mockClear();
		press('g');
		press('s');
		expect(postbox).toHaveBeenCalledTimes(1);
		expect(push).not.toHaveBeenCalled();

		// …and the global meaning comes back the moment the mailbox unmounts.
		release();
		press('g');
		press('s');
		expect(push).toHaveBeenCalledWith('/dashboard/admin');
	});

	it('dispatches the id the user remapped, not the key the code was written with', () => {
		const newItem = vi.fn();
		wrapper = mountHost((api) => {
			api.registerNewShortcut(newItem);
		});

		applyShortcutPreferences('owlat', [{ id: 'global.newItem', keys: ['c'] }]);
		press('c');
		expect(newItem).toHaveBeenCalledTimes(1);
		press('n');
		expect(newItem).toHaveBeenCalledTimes(1);
	});
});

describe('useKeyboardShortcuts — help + escape', () => {
	it('toggles the help modal on ?, and Escape closes it before anything else', () => {
		const escape = vi.fn();
		let api!: ReturnType<typeof useKeyboardShortcuts>;
		wrapper = mountHost((instance) => {
			api = instance;
			instance.registerEscapeHandler(escape);
		});

		press('?', { shiftKey: true });
		expect(api.isHelpModalOpen.value).toBe(true);

		press('Escape');
		expect(api.isHelpModalOpen.value).toBe(false);
		// The sheet ate that Escape; the surface's own handler runs on the next one.
		expect(escape).not.toHaveBeenCalled();
		press('Escape');
		expect(escape).toHaveBeenCalledTimes(1);
	});

	it('reports which catalog entries currently have a handler', () => {
		let api!: ReturnType<typeof useKeyboardShortcuts>;
		wrapper = mountHost((instance) => {
			api = instance;
			instance.registerSaveShortcut(vi.fn());
		});

		expect(api.getRegisteredShortcuts()).toEqual([
			{ id: 'global.save', keys: ['s'], description: 'shared.shortcuts.labels.save' },
		]);
	});
});
