/**
 * "Send invitation" always answers. The session names the workspace before
 * the full organization record has loaded, and the team page is usable in
 * that window, so a click made there still validates the form and still sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import InviteModal from '../InviteModal.vue';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useFormModal } from '~/composables/useFormModal';
import UiInput from '@owlat/ui/components/ui/Input.vue';

const invite = vi.fn(async (_email: string, _role: string, _mailbox?: unknown) => ({
	invitationId: 'inv_1',
}));
const showToast = vi.fn();

async function openModal(): Promise<VueWrapper> {
	installNuxtStubs({
		...i18nStubs,
		useFormModal,
		// The organization record is still loading: only the session knows it.
		useOrganization: () => ({ organizationId: ref(null), invitations: ref([]), invite }),
		useInviteLinks: () => ({ buildAcceptUrl: (id: string) => `/invite/accept?id=${id}` }),
		useToast: () => ({ showToast }),
	});
	const wrapper = mount(InviteModal, {
		global: {
			plugins: [createTestI18n()],
			components: { UiInput },
			stubs: {
				UiModal: {
					props: ['open'],
					template: '<div v-if="open" role="dialog"><slot /><slot name="footer" /></div>',
				},
				InviteSuccessPanel: {
					props: ['success'],
					template: '<p data-testid="invite-success">{{ success.email }}</p>',
				},
			},
		},
	});
	(wrapper.vm as unknown as { open: () => void }).open();
	await flushPromises();
	return wrapper as VueWrapper;
}

async function send(wrapper: VueWrapper, email: string) {
	await wrapper.find('input[type="email"]').setValue(email);
	const sendButton = wrapper
		.findAll('button')
		.find((button) => button.text() === 'Send invitation');
	await sendButton!.trigger('click');
	await flushPromises();
}

beforeEach(() => {
	invite.mockClear();
	showToast.mockClear();
});

describe('invite modal before the organization record has loaded', () => {
	it('reports a missing address', async () => {
		const wrapper = await openModal();
		await send(wrapper, '');

		expect(wrapper.text()).toContain('Email is required');
		expect(invite).not.toHaveBeenCalled();
	});

	it('reports a malformed address', async () => {
		const wrapper = await openModal();
		await send(wrapper, 'not-an-email');

		expect(wrapper.text()).toContain('Please enter a valid email address');
		expect(invite).not.toHaveBeenCalled();
	});

	it('sends a valid invitation', async () => {
		const wrapper = await openModal();
		await send(wrapper, 'jo@owlat.example');

		expect(invite).toHaveBeenCalledWith('jo@owlat.example', 'editor', undefined);
		expect(wrapper.find('[data-testid="invite-success"]').text()).toBe('jo@owlat.example');
	});

	it('says why when the invitation cannot be sent', async () => {
		invite.mockRejectedValueOnce(new Error('No active organization'));
		const wrapper = await openModal();
		await send(wrapper, 'jo@owlat.example');

		expect(showToast).toHaveBeenCalledWith('No active organization', 'error');
		expect(wrapper.find('[data-testid="invite-success"]').exists()).toBe(false);
	});
});
