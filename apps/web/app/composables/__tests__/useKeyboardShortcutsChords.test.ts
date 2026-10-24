/**
 * THE DISPATCHER'S CHORDS AND AVAILABILITY.
 *
 * Cmd/Ctrl chords used to be answered by hand-written listeners (⌘\, ⌘, and
 * ⌘J in the dashboard layout) that no remap could reach. They are catalog ids
 * now, so the dispatcher resolves a modifier chord like any other, fires it
 * while a text field has focus (as the browser's own chords do) and leaves
 * every chord nothing is bound to with the browser. `when` lets a surface say
 * a command cannot run right now without unregistering it.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import {
	applyShortcutPreferences,
	pushShortcutScope,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';
import { claimHelpOverlay } from '~/utils/helpOverlayOwnership';

const mounted: VueWrapper[] = [];

function mountHost(register: (api: ReturnType<typeof useKeyboardShortcuts>) => void): VueWrapper {
	const Host = defineComponent({
		setup() {
			register(useKeyboardShortcuts());
			return () => null;
		},
	});
	const wrapper = mount(Host);
	mounted.push(wrapper);
	return wrapper;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document) {
	const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init });
	target.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	resetShortcutScopes();
	resetShortcutPreferences();
});

afterEach(() => {
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('modifier chords', () => {
	it('fires a bound Cmd chord and a Ctrl chord alike, once each', () => {
		const settings = vi.fn();
		mountHost((api) => api.registerShortcut({ id: 'global.settings', handler: settings }));
		expect(press(',', { metaKey: true }).defaultPrevented).toBe(true);
		press(',', { ctrlKey: true });
		expect(settings).toHaveBeenCalledTimes(2);
	});

	it('fires while a text field has focus, unless the registration opts out', () => {
		const sidebar = vi.fn();
		const settings = vi.fn();
		mountHost((api) => {
			api.registerShortcut({ id: 'global.toggleSidebar', handler: sidebar });
			api.registerShortcut({ id: 'global.settings', handler: settings, ignoreInputs: true });
		});
		const input = document.createElement('input');
		document.body.appendChild(input);
		onTestFinished(() => input.remove());
		input.focus();
		press('\\', { ctrlKey: true }, input);
		press(',', { ctrlKey: true }, input);
		expect(sidebar).toHaveBeenCalledTimes(1);
		expect(settings).not.toHaveBeenCalled();
	});

	it('leaves ⌘K to the palette: a catalogued chord with no handler here is not claimed', () => {
		mountHost(() => {});
		expect(press('k', { metaKey: true }).defaultPrevented).toBe(false);
	});

	it('reads ⌘J the same with Caps Lock on, and ⌘⇧J as a different chord', () => {
		const assistant = vi.fn();
		mountHost((api) => api.registerShortcut({ id: 'global.assistant', handler: assistant }));
		press('J', { metaKey: true });
		expect(assistant).toHaveBeenCalledTimes(1);
		press('J', { metaKey: true, shiftKey: true });
		expect(assistant).toHaveBeenCalledTimes(1);
	});

	it('does nothing while an input method is composing', () => {
		const settings = vi.fn();
		mountHost((api) => api.registerShortcut({ id: 'global.settings', handler: settings }));
		press(',', { ctrlKey: true, isComposing: true });
		expect(settings).not.toHaveBeenCalled();
	});

	it('leaves a pending `g` chord alone', () => {
		const dashboard = vi.fn();
		const settings = vi.fn();
		mountHost((api) => {
			api.registerShortcut({ id: 'global.goToDashboard', handler: dashboard, ignoreInputs: true });
			api.registerShortcut({ id: 'global.settings', handler: settings });
		});
		press('g');
		press(',', { ctrlKey: true });
		press('d');
		expect(settings).toHaveBeenCalledTimes(1);
		expect(dashboard).toHaveBeenCalledTimes(1);
	});
});

describe('remapped chords', () => {
	it.each([
		['global.settings', ',', '.'],
		['global.assistant', 'j', 'u'],
		['global.toggleSidebar', '\\', 'b'],
	])('%s fires on the new chord once, and no longer on the old one', (id, oldKey, newKey) => {
		const handler = vi.fn();
		mountHost((api) => api.registerShortcut({ id, handler }));
		applyShortcutPreferences('owlat', [{ id, keys: [`mod+${newKey}`] }]);
		expect(press(oldKey, { ctrlKey: true }).defaultPrevented).toBe(false);
		expect(handler).not.toHaveBeenCalled();
		press(newKey, { ctrlKey: true });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it.each([
		['inbox.assignToMe', 'i', 'm'],
		['inbox.reply', 'r', 'y'],
		['inbox.note', 'n', 'o'],
	])(
		'%s fires on the new key once inside the Team inbox, not on the old one',
		(id, oldKey, newKey) => {
			const handler = vi.fn();
			mountHost((api) => api.registerShortcut({ id, handler }));
			applyShortcutPreferences('owlat', [{ id, keys: [newKey] }]);
			pushShortcutScope('inbox');
			press(oldKey);
			expect(handler).not.toHaveBeenCalled();
			press(newKey);
			expect(handler).toHaveBeenCalledTimes(1);
		}
	);

	it('takes `n` for the thread note inside the Team inbox and gives it back outside', () => {
		const note = vi.fn();
		const newItem = vi.fn();
		mountHost((api) => {
			api.registerNewShortcut(newItem);
			api.registerShortcut({ id: 'inbox.note', handler: note });
		});
		const release = pushShortcutScope('inbox');
		press('n');
		expect(note).toHaveBeenCalledTimes(1);
		expect(newItem).not.toHaveBeenCalled();
		release();
		press('n');
		expect(newItem).toHaveBeenCalledTimes(1);
	});
});

describe('availability (`when`)', () => {
	it('leaves an unavailable command unclaimed', () => {
		const assistant = vi.fn();
		let on = false;
		mountHost((api) =>
			api.registerShortcut({ id: 'global.assistant', handler: assistant, when: () => on })
		);
		expect(press('j', { metaKey: true }).defaultPrevented).toBe(false);
		on = true;
		expect(press('j', { metaKey: true }).defaultPrevented).toBe(true);
		expect(assistant).toHaveBeenCalledTimes(1);
	});

	it('hands the press to the older registration while the newer one is unavailable', () => {
		const page = vi.fn();
		const panel = vi.fn();
		let panelOpen = true;
		mountHost((api) => api.registerShortcut({ id: 'workbench.next', handler: page }));
		mountHost((api) =>
			api.registerShortcut({ id: 'workbench.next', handler: panel, when: () => panelOpen })
		);
		pushShortcutScope('workbench');
		press('j');
		expect(panel).toHaveBeenCalledTimes(1);
		expect(page).not.toHaveBeenCalled();
		panelOpen = false;
		press('j');
		expect(panel).toHaveBeenCalledTimes(1);
		expect(page).toHaveBeenCalledTimes(1);
	});
});

describe('the "?" sheet, the Ask chord and Escape go through the registry', () => {
	it('opens the sheet on a remapped key, and no longer on "?"', () => {
		let api!: ReturnType<typeof useKeyboardShortcuts>;
		mountHost((instance) => (api = instance));
		applyShortcutPreferences('owlat', [{ id: 'global.help', keys: ['y'] }]);
		expect(press('?', { shiftKey: true }).defaultPrevented).toBe(false);
		expect(api.isHelpModalOpen.value).toBe(false);
		press('y');
		expect(api.isHelpModalOpen.value).toBe(true);
		press('Escape');
		expect(api.isHelpModalOpen.value).toBe(false);
	});

	it('stands down while a surface with its own sheet owns it', () => {
		let api!: ReturnType<typeof useKeyboardShortcuts>;
		mountHost((instance) => (api = instance));
		const release = claimHelpOverlay();
		expect(press('?', { shiftKey: true }).defaultPrevented).toBe(false);
		expect(api.isHelpModalOpen.value).toBe(false);
		release();
		press('?', { shiftKey: true });
		expect(api.isHelpModalOpen.value).toBe(true);
		api.closeHelpModal();
	});

	it("keeps a stored remap onto the palette's Ask chord from firing too", () => {
		// Written before Ask was catalogued: the palette keeps ⌘⇧K, one action per press.
		const settings = vi.fn();
		mountHost((api) => api.registerShortcut({ id: 'global.settings', handler: settings }));
		applyShortcutPreferences('owlat', [{ id: 'global.settings', keys: ['mod+K'] }]);
		expect(press('K', { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
		expect(settings).not.toHaveBeenCalled();
	});

	it("gives Escape to the nearest scope's handler, and to the app-wide close otherwise", () => {
		const leave = vi.fn();
		const close = vi.fn();
		let open = true;
		mountHost((api) => {
			api.registerEscapeHandler(close);
			api.registerShortcut({ id: 'answer.leave', handler: leave, when: () => open });
		});
		const release = pushShortcutScope('answer');
		press('Escape');
		expect(leave).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();
		open = false;
		press('Escape');
		expect(close).toHaveBeenCalledTimes(1);
		release();
		open = true;
		press('Escape');
		expect(leave).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(2);
	});

	it('hands the press to a handler that needs to know which key it was', () => {
		const picked: string[] = [];
		mountHost((api) =>
			api.registerShortcut({
				id: 'askCard.pickOption',
				handler: (event) => picked.push(event.key),
				when: (event) => event.key !== '9',
			})
		);
		pushShortcutScope('askCard');
		press('2');
		expect(press('9').defaultPrevented).toBe(false);
		expect(picked).toEqual(['2']);
	});
});
