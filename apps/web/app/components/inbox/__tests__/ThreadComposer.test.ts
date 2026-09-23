import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import ThreadComposer from '../ThreadComposer.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/**
 * #765 — every Team inbox thread has a reply composer:
 *  - no agent draft: a collapsed "Reply to …" line that opens an empty box and
 *    sends what the person typed;
 *  - an agent draft: the box opens pre-filled, "Review & send" approves it as
 *    is (the fast path), an edit or "Write my own" sends the person's text;
 *  - a state no reply can go to: no box, a plain reason instead.
 */
function mountComposer(props: Record<string, unknown> = {}) {
	return mount(ThreadComposer, {
		props: { senderLabel: 'Ana Ruiz', ...props },
		attachTo: document.body,
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('InboxThreadComposer', () => {
	it('offers a reply line on a thread without a draft, and sends the typed text', async () => {
		const wrapper = mountComposer();
		const open = wrapper.get('[data-testid="thread-composer-open"]');
		expect(open.text()).toContain('Reply to Ana Ruiz');

		await open.trigger('click');
		await wrapper.setProps({ open: true });
		const body = wrapper.get('[data-testid="thread-composer-body"]');
		await body.setValue('We have refunded the invoice.');
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');

		expect(wrapper.emitted('update:open')?.[0]).toEqual([true]);
		expect(wrapper.emitted('send')?.[0]).toEqual(['We have refunded the invoice.', false]);
		expect(wrapper.get('[data-testid="thread-composer-send"]').text()).toBe('Send reply');
		wrapper.unmount();
	});

	it('does not send an empty reply', async () => {
		const wrapper = mountComposer({ open: true });
		const send = wrapper.get('[data-testid="thread-composer-send"]');
		expect(send.attributes('disabled')).toBeDefined();
		await send.trigger('click');
		expect(wrapper.emitted('send')).toBeUndefined();
		wrapper.unmount();
	});

	it('opens pre-filled with the agent draft; Review & send approves it unchanged', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana, here is your invoice.' });
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('Hi Ana, here is your invoice.');
		expect(wrapper.get('[data-testid="thread-composer-draft-hint"]').text()).toBe(
			'Drafted by the agent'
		);

		const send = wrapper.get('[data-testid="thread-composer-send"]');
		expect(send.text()).toBe('Review & send');
		await send.trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana, here is your invoice.', true]);
		wrapper.unmount();
	});

	it('sends an edited draft as the person’s own text and shows what changed', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.', originalDraft: 'Hi Ana.' });
		await wrapper
			.get('[data-testid="thread-composer-body"]')
			.setValue('Hi Ana, sorry for the wait.');

		expect(wrapper.get('[data-testid="thread-composer-diff"]').text()).toContain('Hi Ana.');
		expect(wrapper.find('[data-testid="thread-composer-save"]').exists()).toBe(true);

		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana, sorry for the wait.', false]);

		await wrapper.get('[data-testid="thread-composer-save"]').trigger('click');
		expect(wrapper.emitted('save')?.[0]).toEqual(['Hi Ana, sorry for the wait.']);
		wrapper.unmount();
	});

	it('"Write my own" clears the draft so the person can start over', async () => {
		const wrapper = mountComposer({ draft: 'A draft that is wrong.' });
		await wrapper.get('[data-testid="thread-composer-write-own"]').trigger('click');
		await nextTick();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('');
		expect(
			wrapper.get('[data-testid="thread-composer-send"]').attributes('disabled')
		).toBeDefined();
		wrapper.unmount();
	});

	it('rejects the draft from the skip control, and cancels a plain reply', async () => {
		const withDraft = mountComposer({ draft: 'Draft' });
		await withDraft.get('[data-testid="thread-composer-skip"]').trigger('click');
		expect(withDraft.emitted('reject')).toHaveLength(1);
		withDraft.unmount();

		const plain = mountComposer({ open: true });
		await plain.get('[data-testid="thread-composer-skip"]').trigger('click');
		expect(plain.emitted('reject')).toBeUndefined();
		expect(plain.emitted('update:open')?.at(-1)).toEqual([false]);
		plain.unmount();
	});

	it('sends with Cmd/Ctrl+Enter from the box', async () => {
		const wrapper = mountComposer({ open: true });
		const body = wrapper.get('[data-testid="thread-composer-body"]');
		await body.setValue('Done.');
		await body.trigger('keydown', { key: 'Enter', ctrlKey: true });
		expect(wrapper.emitted('send')?.[0]).toEqual(['Done.', false]);
		wrapper.unmount();
	});

	it('holds sending while a teammate is replying', async () => {
		const wrapper = mountComposer({ draft: 'Draft', held: true, heldReason: 'Dana is replying' });
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		expect(wrapper.emitted('send')).toBeUndefined();
		expect(wrapper.text()).toContain('Dana is replying');
		wrapper.unmount();
	});

	it('explains why no reply can go out instead of offering a box', () => {
		const wrapper = mountComposer({ blocker: 'drafting', draft: 'ignored' });
		expect(wrapper.find('[data-testid="thread-composer-body"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-composer-blocked"]').text()).toContain(
			'The agent is drafting a reply.'
		);
		wrapper.unmount();
	});

	it('reports typing so the "is replying" presence follows the composer', async () => {
		const wrapper = mountComposer({ open: true });
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Hel');
		expect(wrapper.emitted('typing')?.at(-1)).toEqual([true]);
		wrapper.unmount();
	});
});
