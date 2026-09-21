// @vitest-environment happy-dom
/**
 * The inbox's Today ↔ Browse mode keys, driven by real window events.
 *
 * The interesting property is not that `b` toggles — it is that `b` toggles
 * ONLY while the registry says `b` means `postbox.toggleBrowse`. On the Gmail
 * map that key belongs to snooze, and this handler used to flip the mode
 * underneath the snooze dialog on the very same press.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, ref, nextTick, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { usePostboxInboxModes } from '../usePostboxInboxModes';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';

const states = new Map<string, Ref<unknown>>();

let wrapper: VueWrapper | null = null;
let savedInboxMode: Ref<PostboxInboxMode>;
let setInboxMode: ReturnType<typeof vi.fn>;
let openPalette: ReturnType<typeof vi.fn>;

function mountModes(inboxMode: PostboxInboxMode = 'today') {
	savedInboxMode = ref(inboxMode);
	setInboxMode = vi.fn(async (mode: PostboxInboxMode) => {
		savedInboxMode.value = mode;
		return true;
	});
	const Host = defineComponent({
		setup() {
			usePostboxInboxModes({
				folderRole: ref('inbox'),
				folderId: ref(undefined),
				activeMessageId: ref(null),
				railOpen: ref(false),
				savedViewMode: ref('flat'),
				setViewMode: async () => true,
				savedInboxMode,
				setInboxMode,
			});
			return () => null;
		},
	});
	wrapper = mount(Host);
}

function press(key: string, init: KeyboardEventInit = {}) {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...init }));
}

beforeEach(() => {
	states.clear();
	resetShortcutPreferences();
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	openPalette = vi.fn();
	vi.stubGlobal('useCommandPalette', () => ({ open: openPalette }));
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		let state = states.get(key);
		if (!state) states.set(key, (state = ref(init())));
		return state;
	});
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	resetShortcutPreferences();
});

describe('usePostboxInboxModes — mode keys go through the registry', () => {
	it('toggles Today ↔ Browse on the default map', () => {
		mountModes('today');
		press('b');
		expect(setInboxMode).toHaveBeenCalledWith('browse');
	});

	it('leaves `b` alone on the Gmail map, where it means snooze', () => {
		// The preset unbinds postbox.toggleBrowse and gives `b` to snooze. The
		// mode must not flip underneath the snooze dialog.
		applyShortcutPreferences('gmail', []);
		mountModes('today');
		press('b');
		expect(setInboxMode).not.toHaveBeenCalled();
	});

	it('follows a user remap of the toggle', () => {
		applyShortcutPreferences('owlat', [{ id: 'postbox.toggleBrowse', keys: ['w'] }]);
		mountModes('today');
		press('b');
		expect(setInboxMode).not.toHaveBeenCalled();
		press('w');
		expect(setInboxMode).toHaveBeenCalledWith('browse');
	});

	it('keeps Cmd/Ctrl+B working, which the registry deliberately never owns', () => {
		applyShortcutPreferences('gmail', []);
		mountModes('today');
		press('b', { metaKey: true });
		expect(setInboxMode).toHaveBeenCalledWith('browse');
	});

	it('opens the search overlay in Mail scope on the search key, remap included', async () => {
		// Search is the app-wide overlay now: `/` from Today no longer has to flip
		// to Browse to reach a box that lived in the folder rail.
		mountModes('today');
		press('/');
		expect(openPalette).toHaveBeenCalledWith({ scope: 'mail' });
		expect(setInboxMode).not.toHaveBeenCalled();

		await nextTick();
		wrapper?.unmount();
		wrapper = null;

		applyShortcutPreferences('owlat', [{ id: 'postbox.search', keys: [';'] }]);
		states.clear();
		openPalette.mockClear();
		mountModes('today');
		press('/');
		expect(openPalette).not.toHaveBeenCalled();
		press(';');
		expect(openPalette).toHaveBeenCalledWith({ scope: 'mail' });
	});
});
