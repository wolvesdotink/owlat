import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

import PostboxInlineReply from '../PostboxInlineReply.vue';
import type { InlineComposeSpec } from '../../../composables/postbox/usePostboxComposerStack';

/**
 * The inline reply box reuses the REAL compose machinery via PostboxComposer;
 * here the composer is stubbed so we can assert the contract around it:
 *   - expanding renders a composer seeded for the correct thread with the
 *     quoted original,
 *   - promote-to-popup reopens the SAME draft id on the composer stack,
 *   - send collapses (and arms undo-send for the right mailbox).
 */
const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: {
		// Typed so the bare `inline` attribute casts to a real boolean, like the
		// real PostboxComposer's defineProps<{ inline?: boolean }> does.
		inline: { type: Boolean, default: false },
		mailboxId: { type: String, default: undefined },
		draftId: { type: String, default: undefined },
		inReplyToMessageId: { type: String, default: undefined },
		prefillTo: { type: Array, default: undefined },
		prefillCc: { type: Array, default: undefined },
		prefillBcc: { type: Array, default: undefined },
		prefillSubject: { type: String, default: undefined },
		prefillBodyHtml: { type: String, default: undefined },
		forwardAttachmentsFromMessageId: { type: String, default: undefined },
	},
	emits: ['sent', 'discarded', 'minimize', 'promote'],
	template: '<div data-testid="composer-stub" />',
});

const stackOpen = vi.fn(() => 'popup-1');
const undoArm = vi.fn();

vi.stubGlobal('usePostboxComposerStack', () => ({
	open: stackOpen,
	close: vi.fn(),
	minimize: vi.fn(),
	restore: vi.fn(),
}));
vi.stubGlobal('usePostboxUndoSend', () => ({ arm: undoArm }));

const QUOTED = '<blockquote>On Tue, Alice wrote:<br>original body</blockquote>';

const replySpec: InlineComposeSpec = {
	key: 'msg-1:reply',
	kind: 'reply',
	mailboxId: 'mbx-1' as InlineComposeSpec['mailboxId'],
	inReplyToMessageId: 'msg-1' as NonNullable<InlineComposeSpec['inReplyToMessageId']>,
	prefillTo: ['alice@example.com'],
	prefillSubject: 'Re: Hello',
	prefillBodyHtml: QUOTED,
};

let wrapper: VueWrapper | undefined;

function mountInline(spec: InlineComposeSpec | null = null, showReplyAll = true) {
	wrapper = mount(PostboxInlineReply, {
		props: {
			senderLabel: 'Alice',
			showReplyAll,
			spec,
		},
		global: { stubs: { Icon: true }, components: { PostboxComposer: ComposerStub } },
	});
	return wrapper;
}

beforeEach(() => {
	stackOpen.mockClear();
	undoArm.mockClear();
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

describe('PostboxInlineReply', () => {
	it('collapsed: shows the one-line affordance and emits expand kinds', async () => {
		const w = mountInline(null);
		expect(w.text()).toContain('Reply to Alice…');
		expect(w.find('[data-testid="composer-stub"]').exists()).toBe(false);

		await w.get('button').trigger('click'); // main "Reply to …" affordance
		await w.get('[aria-label="Reply all"]').trigger('click');
		await w.get('[title="Forward"]').trigger('click');

		expect(w.emitted('expand')).toEqual([['reply'], ['replyAll'], ['forward']]);
	});

	it('hides the Reply-all icon when reply-all adds nobody', () => {
		const w = mountInline(null, false);
		expect(w.find('[aria-label="Reply all"]').exists()).toBe(false);
		expect(w.find('[title="Forward"]').exists()).toBe(true);
	});

	it('expanded: seeds the composer for the correct thread with the quoted text', () => {
		const w = mountInline(replySpec);
		const composer = w.getComponent(ComposerStub);
		expect(composer.props('inline')).toBe(true);
		expect(composer.props('mailboxId')).toBe('mbx-1');
		expect(composer.props('inReplyToMessageId')).toBe('msg-1');
		expect(composer.props('prefillTo')).toEqual(['alice@example.com']);
		expect(composer.props('prefillSubject')).toBe('Re: Hello');
		expect(composer.props('prefillBodyHtml')).toContain('original body');
		// The collapsed affordance is gone while expanded.
		expect(w.text()).not.toContain('Reply to Alice…');
	});

	it('promote-to-popup reopens the SAME draft id on the stack and collapses', () => {
		const w = mountInline(replySpec);
		w.getComponent(ComposerStub).vm.$emit('promote', {
			draftId: 'draft-42',
			toAddresses: ['alice@example.com', 'bob@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Re: Hello (edited)',
			bodyHtml: `<p>typed so far</p>${QUOTED}`,
		});

		expect(stackOpen).toHaveBeenCalledTimes(1);
		expect(stackOpen).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: 'draft-42',
				mailboxId: 'mbx-1',
				inReplyToMessageId: 'msg-1',
				prefillTo: ['alice@example.com', 'bob@example.com'],
				prefillSubject: 'Re: Hello (edited)',
				prefillBodyHtml: `<p>typed so far</p>${QUOTED}`,
			})
		);
		expect(w.emitted('collapse')).toHaveLength(1);
	});

	it('promote without a draft id (offline autosave failure) still opens a popup, without a draftId key', () => {
		const w = mountInline(replySpec);
		w.getComponent(ComposerStub).vm.$emit('promote', {
			draftId: null,
			toAddresses: ['alice@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Re: Hello',
			bodyHtml: QUOTED,
		});
		expect(stackOpen).toHaveBeenCalledTimes(1);
		const arg = stackOpen.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
		expect('draftId' in arg).toBe(false);
		expect(w.emitted('collapse')).toHaveLength(1);
	});

	it('send arms undo-send for the mailbox and collapses', () => {
		const w = mountInline(replySpec);
		w.getComponent(ComposerStub).vm.$emit('sent', 'undo-token', 1234567);

		expect(undoArm).toHaveBeenCalledWith({
			undoToken: 'undo-token',
			sendAt: 1234567,
			mailboxId: 'mbx-1',
		});
		expect(w.emitted('collapse')).toHaveLength(1);
	});

	it('discard and minimize (Esc) both collapse without arming undo', () => {
		const w = mountInline(replySpec);
		w.getComponent(ComposerStub).vm.$emit('discarded');
		w.getComponent(ComposerStub).vm.$emit('minimize');
		expect(w.emitted('collapse')).toHaveLength(2);
		expect(undoArm).not.toHaveBeenCalled();
	});

	it('collapsing back (spec -> null) restores the affordance', async () => {
		const w = mountInline(replySpec);
		expect(w.find('[data-testid="composer-stub"]').exists()).toBe(true);
		await w.setProps({ spec: null });
		await nextTick();
		expect(w.find('[data-testid="composer-stub"]').exists()).toBe(false);
		expect(w.text()).toContain('Reply to Alice…');
	});
});
