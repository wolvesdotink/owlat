/**
 * The DMARC policy select saves on change. A move to a stricter policy is
 * confirmed first, because from then on receivers spam-folder or refuse the
 * domain's unaligned mail; relaxing the policy saves at once. A declined raise
 * leaves the select on the saved policy.
 */
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

vi.mock('~/composables/useCopyToClipboard', () => ({
	useCopyToClipboard: () => ({ copy: vi.fn(), isCopied: () => false }),
}));

import SendingDnsSection from '../SendingDnsSection.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

/** Renders confirm/cancel while open, like the real dialog's two buttons. */
const ConfirmationDialogStub = defineComponent({
	props: { open: Boolean, title: String },
	emits: ['confirm', 'update:open'],
	setup(props, { emit }) {
		return () =>
			props.open
				? h('div', { 'data-testid': 'dmarc-confirm' }, [
						h('p', props.title),
						h('button', { 'data-testid': 'confirm', onClick: () => emit('confirm') }),
						h('button', {
							'data-testid': 'cancel',
							onClick: () => emit('update:open', false),
						}),
					])
				: null;
	},
});

const OPTIONS = [
	{ value: 'none', label: 'Monitor only', hint: '' },
	{ value: 'quarantine', label: 'Quarantine', hint: '' },
	{ value: 'reject', label: 'Reject', hint: '' },
];

function mountSection(dmarcPolicy: 'none' | 'quarantine' | 'reject') {
	return mount(SendingDnsSection, {
		attachTo: document.body,
		props: {
			domain: {
				_id: 'domain_1',
				domain: 'example.com',
				dmarcPolicy,
				dnsRecords: {
					dmarc: { type: 'TXT', host: '_dmarc', value: `v=DMARC1; p=${dmarcPolicy}` },
				},
				verificationResults: { dmarc: { verified: true } },
			},
			isExpanded: true,
			canManageDomains: true,
			isUpdatingDmarc: false,
			autoRecheckActive: false,
			spfCoexistence: null,
			dmarcPolicyOptions: OPTIONS,
			mailFromHost: null,
		} as never,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				DomainsDNSRecordPanel: true,
				DomainsReturnPathEditor: true,
				DomainsDmarcReportingPanel: true,
				UiConfirmationDialog: ConfirmationDialogStub,
			},
		},
	});
}

describe('SendingDnsSection — DMARC policy changes', () => {
	it('asks before raising the policy, and saves only on confirm', async () => {
		const w = mountSection('none');
		await w.get('select').setValue('reject');
		expect(w.emitted('dmarcChange')).toBeUndefined();
		expect(w.get('[data-testid="dmarc-confirm"]').text()).toContain('Reject');

		await w.get('[data-testid="confirm"]').trigger('click');
		expect(w.emitted('dmarcChange')).toEqual([['reject']]);
		expect(w.find('[data-testid="dmarc-confirm"]').exists()).toBe(false);
		w.unmount();
	});

	it('puts the select back on the saved policy when the raise is declined', async () => {
		const w = mountSection('none');
		await w.get('select').setValue('quarantine');
		await w.get('[data-testid="cancel"]').trigger('click');
		expect(w.emitted('dmarcChange')).toBeUndefined();
		expect((w.get('select').element as HTMLSelectElement).value).toBe('none');
		w.unmount();
	});

	it('relaxes the policy without asking', async () => {
		const w = mountSection('reject');
		await w.get('select').setValue('none');
		expect(w.emitted('dmarcChange')).toEqual([['none']]);
		expect(w.find('[data-testid="dmarc-confirm"]').exists()).toBe(false);
		w.unmount();
	});
});
