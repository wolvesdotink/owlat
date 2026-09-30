// @vitest-environment happy-dom
/**
 * While a reopened draft's body has not loaded, the footer's body controls are
 * disabled, not just ignored (#896). The mode decides which body goes out and a
 * picked signature would become the whole body, so both wait for the saved
 * body; an enabled control that silently did nothing would also leave the
 * signature `<select>` showing a choice that was never applied.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';
import PostboxComposerModeControls from '../PostboxComposerModeControls.vue';

beforeAll(() => {
	Object.assign(globalThis, {
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		useI18n: i18nStubs.useI18n,
		useInboxes: () => ({ byId: ref(new Map()) }),
	});
});

function mountFooter(bodyPending: boolean) {
	return mount(PostboxComposerFooter, {
		props: {
			canSend: false,
			sending: false,
			isUploading: false,
			isScheduled: false,
			sendShortcutHint: 'Cmd+Enter',
			scheduleShortcutHint: 'Cmd+Shift+Enter',
			showSignaturePicker: true,
			signatures: [{ _id: 'sig-1' as never, name: 'Default' }],
			activeSignatureId: null,
			composerMode: 'simple',
			bodyPending,
			persistentToolbar: false,
			lastSavedLabel: '',
			followUpRemindAt: null,
			subject: '',
			bodyHtml: '',
			bodyBlocks: [],
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxComposerModeControls,
				// Renders its panel straight away so the controls inside can be read.
				PostboxOverflowMenu: { template: '<div><slot :close="() => {}" /></div>' },
				UiButton: {
					props: ['disabled'],
					template: '<button :disabled="disabled"><slot /></button>',
				},
			},
			stubs: {
				Icon: true,
				PostboxComposerPreflightChip: true,
				PostboxPreviewAsSent: true,
				PostboxFollowUpDialog: true,
				PostboxComposerFollowUp: true,
			},
		},
	});
}

const modeSwitch = (wrapper: ReturnType<typeof mountFooter>) =>
	wrapper.findAll('button').find((b) => b.text().startsWith('Design layout'))!;

describe('PostboxComposerFooter while the body is loading', () => {
	it('disables the mode switch and the signature picker', () => {
		const wrapper = mountFooter(true);
		expect(wrapper.get('select').attributes('disabled')).toBeDefined();
		expect(modeSwitch(wrapper).attributes('disabled')).toBeDefined();
	});

	it('enables both once the body has loaded', () => {
		const wrapper = mountFooter(false);
		expect(wrapper.get('select').attributes('disabled')).toBeUndefined();
		expect(modeSwitch(wrapper).attributes('disabled')).toBeUndefined();
	});
});
