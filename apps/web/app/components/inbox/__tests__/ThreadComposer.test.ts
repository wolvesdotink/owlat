// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import ThreadComposer from '../ThreadComposer.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});
enableAutoUnmount(afterEach);

/**
 * The Team inbox reply in Answer mode's composer column (#765, plan §07):
 *  - no agent draft: an empty editor that sends what the person typed;
 *  - an agent draft: the editor opens with it, Send approves it as is (the
 *    fast path), an edit sends the person's text; under ⋯ the changes against
 *    the agent's original, "Write my own" (clear), "Discard draft" (reject);
 *  - a teammate replying holds Send, and its label says who;
 *  - a state no reply can go to: no editor, a plain reason instead.
 */
// The ⋯ menu renders its items inline, so a test can click them.
const MenuStub = defineComponent({
	name: 'PostboxOverflowMenu',
	setup:
		(_p, { slots }) =>
		() =>
			h('div', { 'data-testid': 'menu' }, slots.default?.({ close: () => {} })),
});

function mountComposer(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
	return mount(ThreadComposer, {
		props: {
			target: { kind: 'teamThread', threadId: 'th_1', inboundMessageId: 'in_1' },
			senderLabel: 'Ana Ruiz',
			...props,
		},
		slots,
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, PostboxOverflowMenu: MenuStub },
		},
	});
}

describe('InboxThreadComposer in Answer mode', () => {
	it('opens an empty editor on a thread without a draft, and sends the typed text', async () => {
		const wrapper = mountComposer();
		expect(wrapper.get('[data-testid="thread-composer-envelope"]').text()).toContain('To Ana Ruiz');
		const body = wrapper.get('[data-testid="thread-composer-body"]');
		await body.setValue('We have refunded the invoice.');
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');

		expect(wrapper.emitted('send')?.[0]).toEqual(['We have refunded the invoice.', false, '']);
		expect(wrapper.get('[data-testid="thread-composer-send"]').text()).toBe('Send reply');
	});

	it('does not send an empty reply', async () => {
		const wrapper = mountComposer();
		const send = wrapper.get('[data-testid="thread-composer-send"]');
		expect(send.attributes('disabled')).toBeDefined();
		await send.trigger('click');
		expect(wrapper.emitted('send')).toBeUndefined();
	});

	it('opens with the agent draft in the editor; Send approves it unchanged', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana, here is your invoice.' });
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('Hi Ana, here is your invoice.');
		expect(wrapper.get('[data-testid="thread-composer-draft-hint"]').text()).toBe(
			'Drafted by the agent'
		);

		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana, here is your invoice.', true, '']);
	});

	it('sends an edited draft as the person’s own text; the changes are under ⋯', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.', originalDraft: 'Hi Ana.' });
		await wrapper
			.get('[data-testid="thread-composer-body"]')
			.setValue('Hi Ana, sorry for the wait.');
		expect(wrapper.get('[data-testid="thread-composer-draft-hint"]').text()).toBe('Edited draft');

		// The diff is not in the way until asked for.
		expect(wrapper.find('[data-testid="thread-composer-diff"]').exists()).toBe(false);
		await wrapper.get('[data-testid="thread-composer-show-changes"]').trigger('click');
		expect(wrapper.get('[data-testid="thread-composer-diff"]').text()).toContain('Hi Ana.');

		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana, sorry for the wait.', false, '']);

		await wrapper.get('[data-testid="thread-composer-save"]').trigger('click');
		expect(wrapper.emitted('save')?.[0]).toEqual(['Hi Ana, sorry for the wait.', '']);
	});

	it('"Write my own" clears the editor so the person can start over', async () => {
		const wrapper = mountComposer({ draft: 'A draft that is wrong.' });
		await wrapper.get('[data-testid="thread-composer-write-own"]').trigger('click');
		await nextTick();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('');
		expect(
			wrapper.get('[data-testid="thread-composer-send"]').attributes('disabled')
		).toBeDefined();
	});

	it('"Discard draft" rejects the agent draft; a plain reply only clears', async () => {
		const withDraft = mountComposer({ draft: 'Draft' });
		await withDraft.get('[data-testid="thread-composer-skip"]').trigger('click');
		expect(withDraft.emitted('reject')).toHaveLength(1);

		const plain = mountComposer();
		expect(plain.find('[data-testid="thread-composer-skip"]').exists()).toBe(false);
		await plain.get('[data-testid="thread-composer-body"]').setValue('Scratch that');
		await plain.get('[data-testid="thread-composer-clear"]').trigger('click');
		expect(
			plain.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]').element.value
		).toBe('');
		expect(plain.emitted('reject')).toBeUndefined();
	});

	it('sends with Cmd/Ctrl+Enter from the editor', async () => {
		const wrapper = mountComposer();
		const body = wrapper.get('[data-testid="thread-composer-body"]');
		await body.setValue('Done.');
		await body.trigger('keydown', { key: 'Enter', ctrlKey: true });
		expect(wrapper.emitted('send')?.[0]).toEqual(['Done.', false, '']);
	});

	it('holds Send while a teammate is replying, and says who on the button', async () => {
		const wrapper = mountComposer({
			draft: 'Draft',
			held: true,
			heldBy: 'Priya',
			heldReason: 'held while Priya is editing',
		});
		const send = wrapper.get('[data-testid="thread-composer-send"]');
		expect(send.text()).toBe('Priya is replying');
		expect(send.attributes('disabled')).toBeDefined();
		await send.trigger('click');
		expect(wrapper.emitted('send')).toBeUndefined();
		expect(wrapper.get('[data-testid="thread-composer-held"]').text()).toContain(
			'held while Priya is editing'
		);
	});

	it('holds Send while an attachment is not ready, with the reason', async () => {
		const wrapper = mountComposer({
			draft: 'Draft',
			sendHold: 'Send waits until the file is copied.',
		});
		expect(
			wrapper.get('[data-testid="thread-composer-send"]').attributes('disabled')
		).toBeDefined();
		expect(wrapper.get('[data-testid="thread-composer-send-hold"]').text()).toBe(
			'Send waits until the file is copied.'
		);
	});

	it('explains why no reply can go out instead of offering an editor', () => {
		const wrapper = mountComposer({ blocker: 'processing', draft: 'ignored' });
		expect(wrapper.find('[data-testid="thread-composer-body"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-composer-blocked"]').text()).toContain(
			'Owlat is still reading this message.'
		);
	});

	// #807 — the agent still drafting, or the message already answered, no longer
	// block the editor: it opens, and says where the text goes.
	it('says a reply sent mid-draft replaces the agent draft', async () => {
		const wrapper = mountComposer({ notice: 'takesOverDraft' });
		expect(wrapper.get('[data-testid="thread-composer-notice"]').text()).toContain(
			'The agent is still drafting.'
		);
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Here is the answer.');
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Here is the answer.', false, '']);
	});

	it('marks a reply to an answered message as a follow-up', () => {
		const wrapper = mountComposer({ notice: 'followUp' });
		expect(wrapper.find('[data-testid="thread-composer-blocked"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-composer-notice"]').text()).toBe(
			'Already answered. This goes out as a follow-up.'
		);
	});

	it('takes text handed back (an undone follow-up, kept text) and reports it as typed', async () => {
		const wrapper = mountComposer({ subject: 'Re: Invoice' });
		const vm = wrapper.vm as unknown as {
			fill: (b: string, s: string) => void;
			snapshot: () => { body: string; subject: string; touched: boolean };
		};
		vm.fill('The CSV has both variants.', 'Re: Invoice');
		await nextTick();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('The CSV has both variants.');
		expect(vm.snapshot()).toEqual({
			body: 'The CSV has both variants.',
			subject: 'Re: Invoice',
			touched: true,
		});
	});

	it('sends under the pre-filled subject, and an edited subject is the person’s own', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.', subject: 'Re: Invoice' });
		expect(wrapper.get('[data-testid="thread-composer-envelope"]').text()).toContain('Re: Invoice');
		await wrapper.get('[data-testid="thread-composer-envelope"]').trigger('click');
		const subject = wrapper.get('[data-testid="thread-composer-subject"]');
		expect((subject.element as HTMLInputElement).value).toBe('Re: Invoice');

		await subject.setValue('Re: Invoice 1042');
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana.', false, 'Re: Invoice 1042']);
	});

	it('focuses the editor as it opens', async () => {
		const wrapper = mountComposer();
		await nextTick();
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="thread-composer-body"]').element
		);
	});

	it('reports typing so the "is replying" presence follows the composer', async () => {
		const wrapper = mountComposer();
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Hel');
		expect(wrapper.emitted('typing')?.at(-1)).toEqual([true]);
	});

	it('places the agent questions above the editor and the files below it', () => {
		const wrapper = mountComposer(
			{},
			{
				'above-editor': '<div data-testid="ask" />',
				attachments: '<div data-testid="files" />',
			}
		);
		const html = wrapper.html();
		expect(html.indexOf('data-testid="ask"')).toBeLessThan(
			html.indexOf('data-testid="thread-composer-body"')
		);
		expect(html.indexOf('data-testid="files"')).toBeGreaterThan(
			html.indexOf('data-testid="thread-composer-body"')
		);
	});

	// #812 — the team reply is a composer target, so the Postbox composer's
	// advisory pre-send checks run on it too.
	it('flags a placeholder the agent left in its draft, and clears once fixed', async () => {
		const wrapper = mountComposer({
			draft: 'The refund is queued [TODO: add settlement date].',
			subject: 'Re: Invoice',
		});
		expect(wrapper.get('[data-testid="postbox-preflight-chip"]').text()).toContain(
			'[TODO: add settlement date]'
		);

		await wrapper
			.get('[data-testid="thread-composer-body"]')
			.setValue('The refund settles on Friday.');
		expect(wrapper.find('[data-testid="postbox-preflight-chip"]').exists()).toBe(false);
	});

	it('does not ask for a subject a team reply is given anyway', async () => {
		const wrapper = mountComposer();
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('All sorted.');
		expect(wrapper.find('[data-testid="postbox-preflight-chip"]').exists()).toBe(false);
	});
});
