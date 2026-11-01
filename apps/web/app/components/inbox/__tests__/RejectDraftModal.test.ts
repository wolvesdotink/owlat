/**
 * The Team Inbox thread's "Reject draft" confirm: each opening starts from an
 * empty reason, the reason goes to the reject (or nothing when left blank), and
 * the dialog closes only once the reject went through.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import RejectDraftModal from '../RejectDraftModal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const showToast = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useToast: () => ({ showToast }) });
});

const ModalStub = defineComponent({
	props: { open: Boolean },
	template: '<div v-if="open"><slot /><slot name="footer" /></div>',
});

function mountModal(reject: (id: string, reason?: string) => Promise<{ ok: boolean }>) {
	return mount(RejectDraftModal, {
		props: { open: false, messageId: 'msg_1' as never, reject: reject as never },
		global: { plugins: [createTestI18n()], stubs: { UiModal: ModalStub } },
	});
}

const rejectButton = (wrapper: ReturnType<typeof mountModal>) =>
	wrapper.findAll('button').find((b) => b.text() === 'Reject draft')!;

describe('InboxRejectDraftModal', () => {
	it('rejects with the typed reason and closes once it went through', async () => {
		const reject = vi.fn(async () => ({ ok: true }));
		const wrapper = mountModal(reject);
		await wrapper.setProps({ open: true });
		await wrapper.get('textarea').setValue('Wrong customer');
		await rejectButton(wrapper).trigger('click');
		await flushPromises();

		expect(reject).toHaveBeenCalledWith('msg_1', 'Wrong customer');
		expect(wrapper.emitted('update:open')).toEqual([[false]]);
		expect(showToast).toHaveBeenCalled();
	});

	it('stays open when the reject failed, and sends no reason when none was typed', async () => {
		const reject = vi.fn(async () => ({ ok: false }));
		const wrapper = mountModal(reject);
		await wrapper.setProps({ open: true });
		await rejectButton(wrapper).trigger('click');
		await flushPromises();

		expect(reject).toHaveBeenCalledWith('msg_1', undefined);
		expect(wrapper.emitted('update:open')).toBeUndefined();
	});

	it('starts each opening from an empty reason', async () => {
		const wrapper = mountModal(vi.fn(async () => ({ ok: true })));
		await wrapper.setProps({ open: true });
		await wrapper.get('textarea').setValue('Stale');
		await wrapper.setProps({ open: false });
		await wrapper.setProps({ open: true });

		expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
	});
});
