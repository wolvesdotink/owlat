// @vitest-environment happy-dom
/**
 * "?" opens exactly ONE cheat sheet.
 *
 * Two listeners answer the key: the app-wide document listener behind
 * KeyboardShortcutsHelp (useKeyboardShortcuts) and PostboxShortcutHelp's own
 * window listener. On every Postbox route both fired, so one press stacked two
 * overlays. The Postbox sheet now claims the key while it is mounted
 * (utils/helpOverlayOwnership), and the app-wide one stands down.
 *
 * Mounted, not grepped: the defect was two live listeners agreeing to handle
 * the same event, which only a dispatched keypress can show.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref, type Ref } from 'vue';
import { claimHelpOverlay, isHelpOverlayClaimed } from '~/utils/helpOverlayOwnership';
import { isEditableTarget, POSTBOX_SHORTCUT_GROUPS } from '~/utils/postboxShortcuts';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxShortcutHelp from '../postbox/PostboxShortcutHelp.vue';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';

/** The Postbox sheet's `useState` cell, shared across mounts like Nuxt's. */
const postboxHelpOpen = ref(false);
/** The app-wide sheet's open state, captured from the composable on mount. */
let globalHelpOpen: Ref<boolean>;

const modalStub = {
	props: ['open', 'title', 'size'],
	template: '<div v-if="open" data-testid="modal"><slot /></div>',
};

/** A stand-in for the dashboard chrome: it owns the app-wide "?" listener. */
const GlobalHelpHost = defineComponent({
	setup() {
		const { isHelpModalOpen } = useKeyboardShortcuts();
		globalHelpOpen = isHelpModalOpen;
		return () => null;
	},
});

function pressQuestionMark() {
	document.body.dispatchEvent(
		new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true })
	);
	return nextTick();
}

function mountPostboxHelp() {
	return mount(PostboxShortcutHelp, {
		attachTo: document.body,
		global: { plugins: [createTestI18n()], components: { UiModal: modalStub } },
	});
}

beforeEach(() => {
	postboxHelpOpen.value = false;
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useState', () => postboxHelpOpen);
	vi.stubGlobal('isEditableTarget', isEditableTarget);
	vi.stubGlobal('POSTBOX_SHORTCUT_GROUPS', POSTBOX_SHORTCUT_GROUPS);
});

afterEach(() => {
	if (globalHelpOpen) globalHelpOpen.value = false;
});

describe('helpOverlayOwnership', () => {
	it('is unclaimed until a surface claims it, and counts overlapping claims', () => {
		expect(isHelpOverlayClaimed()).toBe(false);
		const releaseA = claimHelpOverlay();
		const releaseB = claimHelpOverlay();
		expect(isHelpOverlayClaimed()).toBe(true);
		// Two surfaces can overlap for a tick across a route change — the first
		// release must not hand the key back while the second still holds it.
		releaseA();
		expect(isHelpOverlayClaimed()).toBe(true);
		releaseB();
		expect(isHelpOverlayClaimed()).toBe(false);
	});

	it('ignores a repeated release (an unmount path that runs twice)', () => {
		const release = claimHelpOverlay();
		release();
		release();
		expect(isHelpOverlayClaimed()).toBe(false);
	});
});

describe('"?" with both cheat sheets alive', () => {
	it('opens only the Postbox sheet while it is mounted', async () => {
		const host = mount(GlobalHelpHost);
		const postbox = mountPostboxHelp();

		await pressQuestionMark();
		expect(postboxHelpOpen.value).toBe(true);
		expect(globalHelpOpen.value).toBe(false);

		postbox.unmount();
		host.unmount();
	});

	it('hands "?" back to the app-wide sheet once the Postbox one unmounts', async () => {
		const host = mount(GlobalHelpHost);
		const postbox = mountPostboxHelp();
		postbox.unmount();

		await pressQuestionMark();
		expect(globalHelpOpen.value).toBe(true);
		expect(postboxHelpOpen.value).toBe(false);

		host.unmount();
	});
});
