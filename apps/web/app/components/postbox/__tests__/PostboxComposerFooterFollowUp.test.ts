// @vitest-environment happy-dom
/**
 * The composer footer's follow-up ("remind me if no reply") chip sits on the
 * footer row, and the picker dialog it opens is rendered by the footer itself,
 * so nothing that closes around the chip (the ⋯ panel beside it) can unmount
 * the dialog mid-interaction. These tests use the real PostboxOverflowMenu,
 * PostboxComposerFollowUp and useClickOutside, with a teleporting dialog
 * stand-in that reports whether it is still mounted.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, Teleport } from 'vue';

import { useClickOutside } from '~/composables/useClickOutside';
import { formatDateTime } from '~/utils/formatters';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { composerTargetCapabilities } from '~/utils/composerTarget';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';
import PostboxComposerFollowUp from '../PostboxComposerFollowUp.vue';
import PostboxOverflowMenu from '../PostboxOverflowMenu.vue';

// The footer as the mailbox composer mounts it: every control its target allows.
const mailboxCapabilities = composerTargetCapabilities({
	kind: 'mailbox',
	mailboxId: 'mbx_1' as never,
});

// Nuxt auto-imports these; the footer/menu/toggle need the real behavior.
beforeAll(() => {
	Object.assign(globalThis, {
		useClickOutside,
		formatDateTime,
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		// The footer/toggle copy flows through vue-i18n now; `useI18n` is a Nuxt
		// auto-import, so it has to exist as a global for their setup.
		useI18n: i18nStubs.useI18n,
		useInboxes: () => ({ byId: ref(new Map()) }),
		// Insert availability (booking page) in the footer's ⋯ menu.
		useFeatureFlag: () => ({ isEnabled: () => false }),
		useToast: () => ({ showToast: vi.fn() }),
	});
});

/** Teleports like UiModal does, so its clicks land outside the ⋯ panel. */
const followUpDialogStub = defineComponent({
	name: 'PostboxFollowUpDialog',
	props: { open: { type: Boolean, default: false } },
	emits: ['update:open', 'confirm'],
	setup(props, { emit }) {
		return () =>
			props.open
				? h(Teleport, { to: 'body' }, [
						h('div', { class: 'follow-up-dialog' }, [
							h('button', { class: 'preset', onClick: () => emit('confirm', 1_700_000_000_000) }),
						]),
					])
				: null;
	},
});

const iconStub = { props: ['name'], template: '<span />' };
const modeControlsStub = { template: '<div class="mode-controls" />' };

let wrapper: VueWrapper | null = null;

function mountFooter() {
	wrapper = mount(PostboxComposerFooter, {
		attachTo: document.body,
		props: {
			capabilities: mailboxCapabilities,
			canSend: true,
			sending: false,
			isUploading: false,
			isScheduled: false,
			sendShortcutHint: 'Cmd+Enter',
			scheduleShortcutHint: 'Cmd+Shift+Enter',
			showSignaturePicker: false,
			signatures: [],
			activeSignatureId: null,
			composerMode: 'rich',
			persistentToolbar: false,
			lastSavedLabel: 'Saved',
			followUpRemindAt: null,
			subject: '',
			bodyHtml: '',
			bodyBlocks: [],
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxOverflowMenu,
				PostboxComposerFollowUp,
				PostboxFollowUpDialog: followUpDialogStub,
				PostboxComposerModeControls: modeControlsStub,
				Icon: iconStub,
			},
			stubs: { PostboxComposerPreflightChip: true, PostboxPreviewAsSent: true },
		},
	});
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.querySelectorAll('.follow-up-dialog').forEach((el) => el.remove());
});

const clickOn = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** Open the follow-up picker from its chip on the footer row. */
async function openPicker(w: VueWrapper) {
	await w.get('button[aria-label="Remind me if no reply"]').trigger('click');
	expect(document.querySelector('.follow-up-dialog')).not.toBeNull();
}

describe('PostboxComposerFooter follow-up picker', () => {
	it('opens the picker from the chip on the footer row, not from ⋯', async () => {
		const w = mountFooter();
		await openPicker(w);
		expect(w.find('[role="menu"]').exists()).toBe(false);
	});

	it('keeps the dialog mounted when ⋯ opens and closes beside it', async () => {
		const w = mountFooter();
		await openPicker(w);
		await w.get('button[aria-label="More compose options"]').trigger('click');
		clickOn(document.body);
		await w.vm.$nextTick();

		expect(w.find('[role="menu"]').exists()).toBe(false);
		expect(document.querySelector('.follow-up-dialog')).not.toBeNull();
	});

	it('delivers the picked deadline', async () => {
		const w = mountFooter();
		await openPicker(w);

		const preset = document.querySelector('.preset') as HTMLElement;
		clickOn(preset);
		await w.vm.$nextTick();

		expect(w.emitted('update:followUpRemindAt')).toEqual([[1_700_000_000_000]]);
	});

	it('clears an armed reminder from its chip without opening the picker', async () => {
		const w = mountFooter();
		await w.setProps({ followUpRemindAt: 1_700_000_000_000 });

		await w.get('button[aria-pressed="true"]').trigger('click');

		expect(document.querySelector('.follow-up-dialog')).toBeNull();
		expect(w.emitted('update:followUpRemindAt')).toEqual([[null]]);
	});
});
