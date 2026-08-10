// @vitest-environment happy-dom
/**
 * The composer footer's follow-up ("remind me if no reply") picker is opened
 * from inside the ⋯ overflow panel, but the dialog itself must be rendered by
 * the footer.
 *
 * Why it matters: the panel is `v-if`-ed, and the dialog teleports to <body>, so
 * the very first click inside the dialog is "outside" the panel. If the dialog
 * were owned by the slot, that click would close the panel and unmount the open
 * dialog mid-interaction. These tests use the real PostboxOverflowMenu,
 * PostboxComposerFollowUp and useClickOutside, with a teleporting dialog stand-in
 * that reports whether it is still mounted.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, Teleport } from 'vue';

import { useClickOutside } from '~/composables/useClickOutside';
import { formatDateTime } from '~/utils/formatters';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';
import PostboxComposerFollowUp from '../PostboxComposerFollowUp.vue';
import PostboxOverflowMenu from '../PostboxOverflowMenu.vue';

// Nuxt auto-imports these; the footer/menu/toggle need the real behavior.
beforeAll(() => {
	Object.assign(globalThis, {
		useClickOutside,
		formatDateTime,
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
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
		},
		global: {
			components: {
				PostboxOverflowMenu,
				PostboxComposerFollowUp,
				PostboxFollowUpDialog: followUpDialogStub,
				PostboxComposerModeControls: modeControlsStub,
				Icon: iconStub,
			},
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

/** Open ⋯, then the follow-up picker from inside it. */
async function openPickerFromMenu(w: VueWrapper) {
	await w.get('button[aria-label="More compose options"]').trigger('click');
	await w.get('button[aria-label="Remind me if no reply"]').trigger('click');
	expect(document.querySelector('.follow-up-dialog')).not.toBeNull();
}

describe('PostboxComposerFooter follow-up picker', () => {
	it('opens the picker from the overflow menu', async () => {
		const w = mountFooter();
		await openPickerFromMenu(w);
		expect(w.find('[role="menu"]').exists()).toBe(true);
	});

	it('keeps the dialog mounted when the menu closes on the dialog click', async () => {
		const w = mountFooter();
		await openPickerFromMenu(w);

		// A click inside the teleported dialog is outside the ⋯ panel.
		const preset = document.querySelector('.preset') as HTMLElement;
		clickOn(preset);
		await w.vm.$nextTick();

		expect(w.find('[role="menu"]').exists()).toBe(false);
		expect(document.querySelector('.follow-up-dialog')).not.toBeNull();
	});

	it('still delivers the picked deadline after the menu has closed', async () => {
		const w = mountFooter();
		await openPickerFromMenu(w);

		// Close the menu first (click elsewhere in the footer's page), then pick.
		clickOn(document.body);
		await w.vm.$nextTick();
		expect(w.find('[role="menu"]').exists()).toBe(false);

		const preset = document.querySelector('.preset') as HTMLElement;
		expect(preset).not.toBeNull();
		clickOn(preset);
		await w.vm.$nextTick();

		expect(w.emitted('update:followUpRemindAt')).toEqual([[1_700_000_000_000]]);
	});

	it('clears an armed reminder from the menu without opening the picker', async () => {
		const w = mountFooter();
		await w.setProps({ followUpRemindAt: 1_700_000_000_000 });
		await w.get('button[aria-label="More compose options"]').trigger('click');

		await w.get('button[aria-pressed="true"]').trigger('click');

		expect(document.querySelector('.follow-up-dialog')).toBeNull();
		expect(w.emitted('update:followUpRemindAt')).toEqual([[null]]);
	});
});
