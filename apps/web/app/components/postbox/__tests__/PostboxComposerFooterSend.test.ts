// @vitest-environment happy-dom
/**
 * The Send button must never wrap. It used to carry the identity inside it
 * ("Send as Ada"), which broke onto two lines in the narrow floating composer.
 * The button now says "Send" and the identity sits beside it, where a long
 * name truncates instead of reflowing the button.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';

beforeAll(() => {
	Object.assign(globalThis, {
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		useI18n: i18nStubs.useI18n,
		useInboxes: () => ({ byId: ref(new Map([['mbx_1', { name: 'Ada' }]])) }),
	});
});

function mountFooter(overrides: Record<string, unknown> = {}) {
	return mount(PostboxComposerFooter, {
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
			subject: '',
			bodyHtml: '',
			bodyBlocks: [],
			...overrides,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				PostboxOverflowMenu: true,
				PostboxComposerPreflightChip: true,
				PostboxPreviewAsSent: true,
				PostboxFollowUpDialog: true,
				PostboxComposerFollowUp: true,
				PostboxComposerModeControls: true,
			},
		},
	});
}

describe('PostboxComposerFooter send button', () => {
	it('says "Send" and names the identity beside it, not inside it', () => {
		const wrapper = mountFooter({ sendAs: { mailboxId: 'mbx_1', label: 'ada@example.com' } });
		const send = wrapper.get('button[title="Cmd+Enter"]');
		expect(send.text()).toBe('Send');
		expect(send.classes()).toContain('whitespace-nowrap');
		expect(wrapper.get('[data-testid="postbox-send-as"]').text()).toBe('as Ada');
	});

	it('shows no identity line when there is none', () => {
		const wrapper = mountFooter();
		expect(wrapper.find('[data-testid="postbox-send-as"]').exists()).toBe(false);
	});

	it('puts the pre-send checks on their own line below Send', () => {
		const wrapper = mountFooter({
			preflight: [{ id: 'emptySubject', key: 'shared.postbox.preflight.emptySubject' }],
		});
		const footer = wrapper.get('footer');
		expect(footer.classes()).toContain('flex-col');
		// The chip is a direct child of the footer, not squeezed into the Send row.
		const chip = footer.element.lastElementChild;
		expect(chip?.tagName.toLowerCase()).toBe('postbox-composer-preflight-chip-stub');
	});
});
