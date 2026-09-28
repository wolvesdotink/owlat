// @vitest-environment happy-dom
/**
 * "Copy missing records" from the sending section: when the domain already
 * publishes a foreign `v=spf1`, the copied text carries the MERGED record — and
 * a comment right above it saying it replaces the existing one. A zone import
 * adds records, and two SPF records fail SPF for all of the domain's mail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

const copy = vi.fn();
vi.mock('~/composables/useCopyToClipboard', () => ({
	useCopyToClipboard: () => ({ copy, isCopied: () => false }),
}));

import SendingDnsSection from '../SendingDnsSection.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const OURS = 'v=spf1 include:_spf.owlat.test ~all';
const MERGED = 'v=spf1 include:_spf.google.com include:_spf.owlat.test ~all';

function mountSection(spfCoexistence: { existing: string; merged: string } | null) {
	return mount(SendingDnsSection, {
		props: {
			domain: {
				_id: 'domain_1',
				domain: 'example.com',
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: OURS },
					dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
				},
				verificationResults: {
					spf: { verified: false, error: 'SPF record does not include Owlat' },
					dmarc: { verified: true },
				},
			},
			isExpanded: true,
			canManageDomains: true,
			isUpdatingDmarc: false,
			autoRecheckActive: false,
			spfCoexistence,
			dmarcPolicyOptions: [{ value: 'none', label: 'None', hint: 'Monitor only.' }],
			mailFromHost: null,
		} as never,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				DomainsDNSRecordPanel: true,
				DomainsReturnPathEditor: true,
			},
		},
	});
}

beforeEach(() => copy.mockClear());

describe('SendingDnsSection — copy missing records', () => {
	it('says the merged SPF record replaces the existing one', async () => {
		const w = mountSection({ existing: 'v=spf1 include:_spf.google.com ~all', merged: MERGED });
		await w.find('[data-testid="dns-copy-zone"]').trigger('click');
		const [text] = copy.mock.calls[0]!;
		const lines = String(text).split('\n');
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^; Replace the existing v=spf1 record/);
		// The note is the localized sentence, never the i18n key path.
		expect(lines[0]).not.toContain('components.domains');
		expect(lines[1]).toBe(`example.com.\t3600\tIN\tTXT\t"${MERGED}"`);
	});

	it('copies the plain record without a note when there is nothing to merge', async () => {
		const w = mountSection(null);
		await w.find('[data-testid="dns-copy-zone"]').trigger('click');
		expect(copy).toHaveBeenCalledWith(`example.com.\t3600\tIN\tTXT\t"${OURS}"`, 'zone-file');
	});
});
