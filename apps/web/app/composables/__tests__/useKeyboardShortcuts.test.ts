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
import { defineComponent, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
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
		// Consumed by the chord, not passed on as a single-key shortcut. The
		// buffer is cleared before window-level handlers run, so the claim has to
		// be visible on the event itself.
		expect(stray.defaultPrevented).toBe(true);
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

describe('useKeyboardShortcuts — one arbiter per press', () => {
	/**
	 * A thread list binds its keydown to the LISTBOX, so its handler runs on the
	 * way up to the document dispatcher. Before the pending chord moved into the
	 * registry neither knew about the other and `g` `s` did both jobs: star the
	 * focused message and navigate to Starred.
	 */
	it('does not let a focused thread list triage the completing key of a chord', async () => {
		const goStarred = vi.fn();
		wrapper = mountHost((api) => {
			api.registerShortcut({ id: 'postbox.goStarred', handler: goStarred, ignoreInputs: true });
		});
		await nextTick();
		const release = pushShortcutScope('postbox');

		const actions: string[] = [];
		const items = ref([{ _id: 'a' }, { _id: 'b' }]);
		const { focusedIndex, onKeydown } = usePostboxListKeyboard({
			items,
			resetKey: ref('inbox'),
			rowDomId: (m) => `row-${m._id}`,
			onActivate: () => {},
			onAction: (key) => actions.push(key),
		});
		const listbox = document.createElement('div');
		listbox.setAttribute('role', 'listbox');
		listbox.addEventListener('keydown', (event) => onKeydown(event as KeyboardEvent));
		document.body.appendChild(listbox);
		const send = (key: string) =>
			listbox.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

		send('j'); // a row is focused — mid-triage, which is when `g s` is used
		expect(focusedIndex.value).toBe(0);

		send('g');
		send('s');

		expect(goStarred).toHaveBeenCalledTimes(1);
		// `s` alone would have starred the focused row.
		expect(actions).not.toContain('s');

		// The chord is spent, so the next `s` is triage again.
		send('s');
		expect(actions).toEqual(['g', 's']);
		expect(goStarred).toHaveBeenCalledTimes(1);

		listbox.remove();
		release();
	});

	/**
	 * The reader (and the inbox mode toggle) bind to the WINDOW, so they run
	 * after the document dispatcher has already cleared the pending chord —
	 * `isChordPending()` is false by then and cannot tell them anything. Their
	 * only remaining signal is `defaultPrevented`, so the dispatcher has to set
	 * it for every chord completion, bound pair or not. Otherwise `g` `u` marks
	 * the open message unread and `g` `#` trashes it.
	 */
	it('marks an UNBOUND chord completion claimed, so window-level triage stands down', async () => {
		wrapper = mountHost((api) => {
			api.registerNavigationShortcuts();
		});
		await nextTick();

		const readerActions: string[] = [];
		const reader = (event: KeyboardEvent) => {
			// Verbatim shape of PostboxThreadReader.onReaderShortcut's guard.
			if (event.defaultPrevented) return;
			readerActions.push(event.key);
		};
		window.addEventListener('keydown', reader);

		// `bubbles`, so the press reaches the window listener the way a real one
		// does — after the document dispatcher has had its say.
		press('g', { bubbles: true });
		const tail = press('u', { bubbles: true });

		expect(tail.defaultPrevented).toBe(true);
		expect(readerActions).toEqual([]);
		expect(push).not.toHaveBeenCalled();

		// …and the very next `u`, with no chord in flight, is triage again.
		press('u', { bubbles: true });
		expect(readerActions).toEqual(['u']);

		window.removeEventListener('keydown', reader);
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
