/**
 * A transactional email's test send starts from the template's example
 * values, so the test reads like a real email without the author typing
 * sample data again; a variable without an example starts empty, as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import SendTestEmailModal from '../SendTestEmailModal.vue';

vi.mock('@owlat/api', () => ({
	api: {
		workspaces: { settings: { get: 'workspaces.settings.get' } },
		domains: { domains: { listByOrganization: 'domains.domains.listByOrganization' } },
		campaigns: { testSend: { sendTestEmailFromTemplate: 'campaigns.testSend.send' } },
	},
}));

const action = vi.fn(async () => ({ success: true, message: 'Queued' }));

Object.assign(globalThis, {
	...i18nStubs,
	computed,
	ref,
	watch,
	useId: () => 'id',
	useToast: () => ({ showToast: vi.fn() }),
	useConvex: () => ({ action }),
	useOrganizationQuery: (query: string) => ({
		data: ref(
			query === 'domains.domains.listByOrganization'
				? [{ status: 'verified', domain: 'owlat.app' }]
				: { defaultFromEmail: 'hello@owlat.app' }
		),
	}),
});

const stubs = {
	I18nT: { template: '<span />' },
	UiIconBox: { template: '<span />' },
	UiModal: { template: '<div><slot /><slot name="footer" /></div>' },
	UiTooltip: { template: '<span><slot /></span>' },
	UiSpinner: true,
	UiButton: {
		props: ['disabled'],
		emits: ['click'],
		template:
			'<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
	},
};

describe('SendTestEmailModal', () => {
	it("sends a transactional email's example values as the test's data variables", async () => {
		const wrapper = mount(SendTestEmailModal, {
			props: {
				open: false,
				html: '<p>x</p>',
				subject: 'Your order {{orderNumber}}',
				dataVariableSchema: [
					{ key: 'orderNumber', type: 'string', example: 'A-1001' },
					{ key: 'isExpress', type: 'boolean', example: true },
					{ key: 'items', type: 'array', example: [{ name: 'Notebook', quantity: 2 }] },
					{ key: 'giftNote', type: 'string' },
				],
			},
			global: { plugins: [createTestI18n()], stubs },
		});
		await wrapper.setProps({ open: true });

		await wrapper.get('input[type="email"]').setValue('dev@owlat.app');
		const send = wrapper.findAll('button').find((b) => b.text().includes('Queue test'));
		await send!.trigger('click');

		expect(action).toHaveBeenCalledTimes(1);
		expect(action.mock.calls[0]).toEqual([
			'campaigns.testSend.send',
			expect.objectContaining({
				dataVariables: {
					orderNumber: 'A-1001',
					isExpress: 'true',
					items: '[{"name":"Notebook","quantity":2}]',
				},
			}),
		]);
	});
});
