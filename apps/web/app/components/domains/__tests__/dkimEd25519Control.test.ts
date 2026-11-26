/**
 * The optional Ed25519 DKIM key on an MTA domain's sending records: the row is
 * labelled optional and left out of the "records to publish" count, and the
 * control adds the key when there is none and removes it after a confirmation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('~/composables/useCopyToClipboard', () => ({
	useCopyToClipboard: () => ({ copy: vi.fn(), isCopied: () => false }),
}));

import SendingDnsSection from '../SendingDnsSection.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const runs: Record<string, ReturnType<typeof vi.fn>> = {};

beforeEach(() => {
	runs['add'] = vi.fn(async () => ({ ok: true, result: { selector: 'e1', dnsRecord: 'v' } }));
	runs['remove'] = vi.fn(async () => ({ ok: true, result: null }));
	// The control's two operations, told apart by their label.
	vi.stubGlobal('useBackendOperation', (_op: unknown, opts: { label: () => string }) => ({
		run: opts.label().includes('Remove') ? runs['remove'] : runs['add'],
		isLoading: ref(false),
	}));
});

/** Renders confirm while open, like the real dialog's confirm button. */
const ConfirmationDialogStub = defineComponent({
	props: { open: Boolean, title: String },
	emits: ['confirm', 'update:open'],
	setup(props, { emit }) {
		return () =>
			props.open
				? h('div', { 'data-testid': 'ed25519-confirm' }, [
						h('p', props.title),
						h('button', { 'data-testid': 'confirm', onClick: () => emit('confirm') }),
					])
				: null;
	},
});

/** Records the label each record row is given. */
const RecordPanelStub = defineComponent({
	props: { label: String },
	setup: (props) => () => h('div', { 'data-testid': 'record-panel' }, props.label),
});

const RSA = { type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=KEY' };
const ED = {
	type: 'TXT',
	host: 'e1._domainkey',
	value: 'v=DKIM1; k=ed25519; p=KEY',
	optional: true,
};

function mountSection(dkim: unknown[], dkimResults?: unknown[], canCarryEd25519Key = true) {
	return mount(SendingDnsSection, {
		attachTo: document.body,
		props: {
			domain: {
				_id: 'domain_1',
				domain: 'example.com',
				canCarryEd25519Key,
				dnsRecords: {
					dkim,
					dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
				},
				verificationResults: dkimResults
					? { dkim: dkimResults, dmarc: { verified: true } }
					: undefined,
			},
			isExpanded: true,
			canManageDomains: true,
			isUpdatingDmarc: false,
			autoRecheckActive: false,
			spfCoexistence: null,
			dmarcPolicyOptions: [{ value: 'none', label: 'Monitor only', hint: '' }],
			mailFromHost: null,
		} as never,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				DomainsDNSRecordPanel: RecordPanelStub,
				DomainsReturnPathEditor: true,
				DomainsDmarcReportingPanel: true,
				UiConfirmationDialog: ConfirmationDialogStub,
			},
		},
	});
}

describe('the optional Ed25519 DKIM key', () => {
	it('labels the row optional and leaves it out of the outstanding count', () => {
		const w = mountSection([RSA, ED], [{ verified: true }, { verified: false }]);
		expect(w.findAll('[data-testid="record-panel"]').map((p) => p.text())).toEqual([
			'DKIM',
			'DKIM Ed25519 (optional)',
			'DMARC',
		]);
		// Every required record is found, so the summary reports nothing to publish.
		expect(w.get('[data-testid="dns-checklist-summary"]').text()).not.toContain('Ed25519');
		expect(w.get('[data-testid="dns-checklist-summary"]').text()).toContain('2');
		w.unmount();
	});

	it('offers to add the key when the domain has none', async () => {
		const w = mountSection([RSA]);
		expect(w.get('[data-testid="dkim-ed25519-control"]').text()).toContain('ignore it');
		await w.get('[data-testid="dkim-ed25519-add"]').trigger('click');
		expect(runs['add']).toHaveBeenCalledWith({ domainId: 'domain_1' });
		expect(w.find('[data-testid="dkim-ed25519-remove"]').exists()).toBe(false);
		w.unmount();
	});

	it('removes the key only after the confirmation', async () => {
		const w = mountSection([RSA, ED]);
		await w.get('[data-testid="dkim-ed25519-remove"]').trigger('click');
		expect(runs['remove']).not.toHaveBeenCalled();
		await w.get('[data-testid="confirm"]').trigger('click');
		await flushPromises();
		expect(runs['remove']).toHaveBeenCalledWith({ domainId: 'domain_1' });
		expect(w.find('[data-testid="ed25519-confirm"]').exists()).toBe(false);
		w.unmount();
	});

	it('is not offered for a domain another provider sends for', () => {
		const w = mountSection([RSA], undefined, false);
		expect(w.find('[data-testid="dkim-ed25519-control"]').exists()).toBe(false);
		w.unmount();
	});
});
