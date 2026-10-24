/**
 * One press, one action, when a remap lands on keys a fixed listener answers
 * itself. The remap check refuses such a chord now, but a remap stored before
 * it (or written by another client) can still be live: the dispatcher runs
 * first on the document and claims the press, and the palette and workspace
 * listeners on the window stand down for a claimed press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { listenForCommandPaletteTriggers } from '../useCommandPalette';
import { useWorkspaceHotkeys } from '../useWorkspaceHotkeys';
import {
	applyShortcutPreferences,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';

const mounted: VueWrapper[] = [];
const detach: Array<() => void> = [];
const switchTo = vi.fn();
const settings = vi.fn();

function mountHost(setup: () => void): void {
	mounted.push(
		mount(defineComponent({ setup: () => (setup(), () => null) }), { attachTo: document.body })
	);
}

function press(init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
	document.body.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true) }));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		workspaces: ref([{ id: 'ws_a' }, { id: 'ws_b' }]),
		switchTo,
	}));
	switchTo.mockClear();
	settings.mockClear();
	resetShortcutScopes();
	resetShortcutPreferences();
	mountHost(() => {
		useKeyboardShortcuts().registerShortcut({ id: 'global.settings', handler: settings });
	});
});

afterEach(() => {
	for (const off of detach.splice(0)) off();
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('the command palette', () => {
	function attachPalette() {
		const toggle = vi.fn();
		detach.push(
			listenForCommandPaletteTriggers({ toggle, ask: vi.fn(), open: vi.fn() }, () => true)
		);
		return toggle;
	}

	it('still answers Ctrl+Alt+K when nothing else does', () => {
		const toggle = attachPalette();
		press({ key: 'k', ctrlKey: true, altKey: true });
		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it('stands down when a stored remap of Settings took Ctrl+Alt+K', () => {
		const toggle = attachPalette();
		applyShortcutPreferences('owlat', [{ id: 'global.settings', keys: ['mod+alt+k'] }]);
		press({ key: 'k', ctrlKey: true, altKey: true });
		expect(settings).toHaveBeenCalledTimes(1);
		expect(toggle).not.toHaveBeenCalled();
	});
});

describe('the desktop workspace switch', () => {
	const ctrlShift1 = { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true };

	it('still switches on Ctrl+Shift+1 when nothing else claims it', () => {
		mountHost(useWorkspaceHotkeys);
		press(ctrlShift1);
		expect(switchTo).toHaveBeenCalledWith('ws_a');
	});

	it('stands down when a stored remap of Settings took Ctrl+Shift+1', () => {
		mountHost(useWorkspaceHotkeys);
		applyShortcutPreferences('owlat', [{ id: 'global.settings', keys: ['mod+!'] }]);
		press(ctrlShift1);
		expect(settings).toHaveBeenCalledTimes(1);
		expect(switchTo).not.toHaveBeenCalled();
	});
});
