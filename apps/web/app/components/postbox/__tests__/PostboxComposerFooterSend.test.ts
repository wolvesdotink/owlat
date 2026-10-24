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
import { composerTargetCapabilities } from '~/utils/composerTarget';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';

// The footer as the mailbox composer mounts it: every control its target allows.
const mailboxCapabilities = composerTargetCapabilities({
	kind: 'mailbox',
	mailboxId: 'mbx_1' as never,
});

beforeAll(() => {
	Object.assign(globalThis, {
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		useI18n: i18nStubs.useI18n,
		useInboxes: () => ({ byId: ref(new Map([['mbx_1', { name: 'Ada' }]])) }),
		// Insert availability (booking page) in the footer's ⋯ menu.
		useFeatureFlag: () => ({ isEnabled: () => false }),
		useToast: () => ({ showToast: vi.fn() }),
	});
});

function mountFooter(overrides: Record<string, unknown> = {}) {
	return mount(PostboxComposerFooter, {
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

describe('PostboxComposerFooter: a reply’s Send', () => {
	const actions = {
		primary: 'done',
		chords: { done: 'Ctrl+Enter', keep: 'Ctrl+Alt+Enter' },
		aria: { done: 'Control+Enter', keep: 'Control+Alt+Enter' },
	};

	it('says what Send does with the conversation, and sends with the setting', async () => {
		const wrapper = mountFooter({ sendActions: actions });
		const send = wrapper.get('[data-testid="composer-send"]');
		expect(send.attributes('title')).toBe('Send and mark done (Ctrl+Enter)');
		await send.trigger('click');
		expect(wrapper.emitted('send')).toEqual([[undefined]]);
		wrapper.unmount();
	});

	it('offers both ways beside Send, each with the chord that takes it', async () => {
		const wrapper = mountFooter({ sendActions: actions });
		await wrapper.get('[data-testid="composer-send-options"]').trigger('click');
		const entry = (action: string) =>
			document.body.querySelector<HTMLElement>(`[data-testid="composer-send-${action}"]`)!;
		expect(entry('keep').textContent).toContain('Send and keep in Inbox');
		expect(entry('keep').textContent).toContain('Ctrl+Alt+Enter');
		expect(entry('keep').getAttribute('aria-keyshortcuts')).toBe('Control+Alt+Enter');
		expect(entry('done').textContent).toContain('Send and mark done');
		expect(entry('done').textContent).toContain('Ctrl+Enter');
		entry('keep').click();
		expect(wrapper.emitted('send')).toEqual([['keep']]);
		wrapper.unmount();
	});

	it('is a plain Send for a new message or a forward', () => {
		const wrapper = mountFooter();
		expect(wrapper.find('[data-testid="composer-send-options"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="composer-send"]').attributes('title')).toBe('Cmd+Enter');
	});
});
