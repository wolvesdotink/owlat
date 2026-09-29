import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';

import PostboxInlineReply from '../PostboxInlineReply.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { InlineComposeSpec } from '../../../composables/postbox/usePostboxComposerStack';

/**
 * The inline reply box reuses the REAL compose machinery via PostboxComposer;
 * here the composer is stubbed so we can assert the contract around it:
 *   - expanding renders a composer seeded for the correct thread with the
 *     quoted original,
 *   - promote-to-popup reopens the SAME draft id on the composer stack,
 *   - the whole seed is forwarded (attachments included), send only
 *     collapses (the composer arms undo-send itself),
 *   - and, since plan §05 moved it here from the AI strip, that Draft reply
 *     dispatches only when the `ai` flag is on and hands the chosen suggestion
 *     back verbatim.
 */
const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: {
		// Typed so the bare `inline` attribute casts to a real boolean, like the
		// real PostboxComposer's defineProps<{ inline?: boolean }> does.
		inline: { type: Boolean, default: false },
		seed: { type: Object, required: true },
		replyAllRecipients: { type: Array, default: undefined },
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
}));
// Present only to prove the box no longer arms undo-send on its own.
vi.stubGlobal('usePostboxUndoSend', () => ({ arm: undoArm }));
// Draft reply's one backend action (mail.ai.assist.suggestReplies).
const suggestRun = vi.fn(async (_a: unknown): Promise<unknown> => ({ ok: false }));
const suggestLoading = ref(false);
vi.stubGlobal('useBackendOperation', () => ({ run: suggestRun, isLoading: suggestLoading }));
// Streamed suggestions: the buffer the options arrive through, and its create/delete.
const streamData = ref<{ status: string; text: string } | undefined>(undefined);
vi.stubGlobal('useConvexQuery', () => ({ data: streamData }));
const convexMutation = vi.fn(async (_ref: unknown, _args: unknown): Promise<unknown> => 'stream-1');
vi.stubGlobal('requireConvex', () => ({ mutation: convexMutation }));
// The box renders its copy through vue-i18n; `useI18n` is a Nuxt auto-import.
vi.stubGlobal('useI18n', i18nStubs.useI18n);

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

function mountInline(
	spec: InlineComposeSpec | null = null,
	showReplyAll = true,
	extra: { aiEnabled?: boolean; draftMessageId?: string } = {}
) {
	wrapper = mount(PostboxInlineReply, {
		props: {
			senderLabel: 'Alice',
			showReplyAll,
			spec,
			...extra,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true },
			components: { PostboxComposer: ComposerStub },
		},
	});
	return wrapper;
}

beforeEach(() => {
	stackOpen.mockClear();
	undoArm.mockClear();
	suggestRun.mockClear();
	suggestLoading.value = false;
	suggestRun.mockResolvedValue({ ok: false });
	streamData.value = undefined;
	convexMutation.mockClear();
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
		expect(composer.props('seed')).toMatchObject({
			mailboxId: 'mbx-1',
			inReplyToMessageId: 'msg-1',
			prefillTo: ['alice@example.com'],
			prefillSubject: 'Re: Hello',
		});
		expect((composer.props('seed') as InlineComposeSpec).prefillBodyHtml).toContain(
			'original body'
		);
		// The collapsed affordance is gone while expanded.
		expect(w.text()).not.toContain('Reply to Alice…');
	});

	it('forwards the whole seed, including the fields the old prop list dropped', () => {
		const attachment = {
			storageId: 'st-1',
			filename: 'report.pdf',
			contentType: 'application/pdf',
			size: 1200,
		};
		const spec: InlineComposeSpec = {
			...replySpec,
			kind: 'forward',
			key: 'msg-1:forward',
			prefillAttachments: [attachment as never],
			attachPendingKey: 'pending-7',
			forwardAttachmentsFromMessageId: 'msg-1' as never,
			replyAllRecipients: ['carol@example.com'],
		};
		const composer = mountInline(spec).getComponent(ComposerStub);
		expect(composer.props('seed')).toMatchObject({
			prefillAttachments: [attachment],
			attachPendingKey: 'pending-7',
			forwardAttachmentsFromMessageId: 'msg-1',
		});
		expect(composer.props('replyAllRecipients')).toEqual(['carol@example.com']);
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

	it('send collapses, leaving the undo window to the composer', () => {
		const w = mountInline(replySpec);
		w.getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });

		// The composer's send() arms it; a second arm here would replay the sound.
		expect(undoArm).not.toHaveBeenCalled();
		expect(w.emitted('collapse')).toHaveLength(1);
	});

	it('discard and minimize (Esc) both collapse without arming undo', () => {
		const w = mountInline(replySpec);
		w.getComponent(ComposerStub).vm.$emit('discarded');
		w.getComponent(ComposerStub).vm.$emit('minimize');
		expect(w.emitted('collapse')).toHaveLength(2);
		expect(undoArm).not.toHaveBeenCalled();
	});

	it('offers Draft reply only with the ai flag and a message to answer', () => {
		expect(mountInline(null).find('[aria-label="Draft a reply"]').exists()).toBe(false);
		wrapper?.unmount();
		expect(
			mountInline(null, true, { aiEnabled: true }).find('[aria-label="Draft a reply"]').exists()
		).toBe(false);
		wrapper?.unmount();
		expect(
			mountInline(null, true, { aiEnabled: true, draftMessageId: 'msg-1' })
				.find('[aria-label="Draft a reply"]')
				.exists()
		).toBe(true);
	});

	it('draft reply hands the chosen suggestion back verbatim', async () => {
		suggestRun.mockResolvedValue({ ok: true, result: { replies: ['On it — will send today.'] } });
		const w = mountInline(null, true, { aiEnabled: true, draftMessageId: 'msg-1' });

		await w.get('[aria-label="Draft a reply"]').trigger('click');
		await flushPromises();
		expect(suggestRun).toHaveBeenCalledTimes(1);

		await w.get('[aria-label="Suggested replies"] button').trigger('click');
		expect(w.emitted('use-reply')![0]).toEqual(['On it — will send today.']);

		// Toggling shut hides the cards without asking again.
		await w.get('[aria-label="Draft a reply"]').trigger('click');
		expect(w.find('[data-testid="inline-reply-suggestions"]').exists()).toBe(false);
		expect(suggestRun).toHaveBeenCalledTimes(1);
	});

	it('shows suggestions as they stream, with the one still being written not pickable', async () => {
		let finish!: (v: unknown) => void;
		suggestRun.mockImplementation(
			() =>
				new Promise((res) => {
					finish = res;
				})
		);
		const w = mountInline(null, true, { aiEnabled: true, draftMessageId: 'msg-1' });
		await w.get('[aria-label="Draft a reply"]').trigger('click');
		await flushPromises();
		expect(suggestRun.mock.calls[0]![0]).toEqual({ messageId: 'msg-1', streamId: 'stream-1' });

		streamData.value = {
			status: 'streaming',
			text: JSON.stringify(['On it — will send today.', 'Can this wait until']),
		};
		await nextTick();
		const cards = w.findAll('[aria-label="Suggested replies"] button');
		expect(cards.map((c) => c.text())).toEqual(['On it — will send today.', 'Can this wait until']);
		expect(cards[0]!.attributes('disabled')).toBeUndefined();
		expect(cards[1]!.attributes('disabled')).toBeDefined();
		await cards[0]!.trigger('click');
		expect(w.emitted('use-reply')![0]).toEqual(['On it — will send today.']);

		finish({
			ok: true,
			result: { replies: ['On it — will send today.', 'Can this wait until Monday?'] },
		});
		await flushPromises();
		const final = w.findAll('[aria-label="Suggested replies"] button');
		expect(final[1]!.text()).toBe('Can this wait until Monday?');
		expect(final[1]!.attributes('disabled')).toBeUndefined();
		// The buffer is deleted once the run is over.
		expect(convexMutation).toHaveBeenLastCalledWith(expect.anything(), { streamId: 'stream-1' });
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
