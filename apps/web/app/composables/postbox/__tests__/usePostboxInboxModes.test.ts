/**
 * The inbox's Today ↔ Browse mode keys, driven by real window events.
 *
 * The interesting property is not that `b` toggles — it is that `b` toggles
 * ONLY while the registry says `b` means `postbox.toggleBrowse`. On the Gmail
 * map that key belongs to snooze, and this handler used to flip the mode
 * underneath the snooze dialog on the very same press.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, reactive, ref, nextTick, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { usePostboxInboxModes } from '../usePostboxInboxModes';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';

const states = new Map<string, Ref<unknown>>();

let wrapper: VueWrapper | null = null;
let savedInboxMode: Ref<PostboxInboxMode>;
let setInboxMode: ReturnType<typeof vi.fn>;
let openPalette: ReturnType<typeof vi.fn>;
let modes: ReturnType<typeof usePostboxInboxModes>;
const setViewMode = vi.fn(async () => true);
const route = reactive({ query: {} as Record<string, unknown> });
const routerReplace = vi.fn((loc: { query: Record<string, unknown> }) => {
	route.query = loc.query;
});

function mountModes(inboxMode: PostboxInboxMode = 'today') {
	savedInboxMode = ref(inboxMode);
	setInboxMode = vi.fn(async (mode: PostboxInboxMode) => {
		savedInboxMode.value = mode;
		return true;
	});
	const Host = defineComponent({
		setup() {
			modes = usePostboxInboxModes({
				folderRole: ref('inbox'),
				folderId: ref(undefined),
				activeMessageId: ref(null),
				railOpen: ref(false),
				savedViewMode: ref('conversations'),
				setViewMode,
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
	routerReplace.mockClear();
	route.query = {};
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('useRouter', () => ({ replace: routerReplace }));
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

describe("usePostboxInboxModes — the Priority view's digest filter (read on arrival §3)", () => {
	it('the digest link only sets the URL; the saved modes stay untouched', () => {
		route.query = { q: 'kept' };
		mountModes('today');
		modes.viewDigest();
		expect(routerReplace).toHaveBeenCalledWith({ query: { q: 'kept', placement: 'digest' } });
		expect(modes.inboxMode.value).toBe('browse');
		expect(modes.viewMode.value).toBe('flat');
		expect(setInboxMode).not.toHaveBeenCalled();
		expect(setViewMode).not.toHaveBeenCalled();
	});

	it('a reload on ?placement=digest lands on the filtered flat list whatever was saved', () => {
		route.query = { placement: 'digest' };
		// Saved: Today, and the Conversations renderer.
		mountModes('today');
		expect(modes.inboxMode.value).toBe('browse');
		expect(modes.todayActive.value).toBe(false);
		expect(modes.viewMode.value).toBe('flat');
		expect(modes.activeListRenderer.value).toBe('flat');
	});

	it('choosing another renderer drops the filter instead of hiding it', () => {
		route.query = { placement: 'digest', q: 'kept' };
		mountModes('today');
		modes.selectViewMode('categories');
		expect(route.query).toEqual({ q: 'kept' });
		expect(modes.viewMode.value).toBe('categories');
	});

	it('going back to Priority drops the filter', () => {
		route.query = { placement: 'digest' };
		mountModes('today');
		modes.switchInboxMode('today');
		expect(route.query).toEqual({});
		expect(modes.inboxMode.value).toBe('today');
	});
});
