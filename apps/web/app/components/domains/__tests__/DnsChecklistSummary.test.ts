/**
 * The checklist summary above a sending domain's records: the count, a link to
 * each outstanding record by its own name, and one copy of exactly those
 * records as zone-file lines.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';

const copy = vi.fn();
vi.mock('~/composables/useCopyToClipboard', () => ({
	useCopyToClipboard: () => ({ copy, isCopied: () => false }),
}));

import DnsChecklistSummary from '../DnsChecklistSummary.vue';
import { buildSendingChecklist } from '~/utils/dnsRecordChecklist';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const ok = { verified: true };
const missing = { verified: false, error: 'No record found' };

const entriesFor = (verificationResults?: Record<string, unknown>) =>
	buildSendingChecklist({
		dnsRecords: {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.owlat.test ~all' },
			dkim: [
				{ type: 'CNAME', host: 'a._domainkey', value: 'a.dkim.owlat.test' },
				{ type: 'CNAME', host: 'b._domainkey', value: 'b.dkim.owlat.test' },
			],
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
		},
		verificationResults,
	});

function mountSummary(
	verificationResults?: Record<string, unknown>,
	valueOverrides?: Record<string, string>
) {
	return mount(DnsChecklistSummary, {
		props: {
			entries: entriesFor(verificationResults),
			domain: 'example.com',
			anchorFor: (entry: { id: string }) => `dns-d1-${entry.id}`,
			valueOverrides,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

const headline = (w: ReturnType<typeof mountSummary>) =>
	w.find('[data-testid="dns-checklist-headline"]').text();

beforeEach(() => copy.mockClear());

describe('DnsChecklistSummary', () => {
	it('counts found records and links each outstanding one by name', () => {
		const w = mountSummary({ spf: ok, dkim: [ok, missing], dmarc: missing });
		expect(headline(w)).toBe('2 of 4 records found');
		expect(w.findAll('[data-testid="dns-outstanding-link"]').map((l) => l.text())).toEqual([
			'DKIM 2',
			'DMARC',
		]);
		expect(w.find('[data-testid="dns-copy-zone"]').text()).toBe('Copy the 2 missing records');
	});

	it('copies only the outstanding records as zone-file lines', async () => {
		const w = mountSummary({ spf: ok, dkim: [ok, missing], dmarc: ok });
		expect(w.find('[data-testid="dns-copy-zone"]').text()).toBe('Copy the missing record');
		await w.find('[data-testid="dns-copy-zone"]').trigger('click');
		expect(copy).toHaveBeenCalledWith(
			'b._domainkey.example.com.\t3600\tIN\tCNAME\tb.dkim.owlat.test.',
			'zone-file'
		);
	});

	it('copies the merged SPF record when one is suggested', async () => {
		const w = mountSummary(
			{ spf: missing, dkim: [ok, ok], dmarc: ok },
			{ spf: 'v=spf1 merged ~all' }
		);
		await w.find('[data-testid="dns-copy-zone"]').trigger('click');
		expect(copy).toHaveBeenCalledWith(
			'example.com.\t3600\tIN\tTXT\t"v=spf1 merged ~all"',
			'zone-file'
		);
	});

	it('comments out a return-path record from another zone and says where it goes', async () => {
		const entries = buildSendingChecklist({
			dnsRecords: {
				mailFrom: [
					{ type: 'MX', hostname: 'bounces.owlat.test', value: 'mx.owlat.test', priority: 10 },
				],
			},
			verificationResults: { mailFrom: [missing] },
		});
		const w = mount(DnsChecklistSummary, {
			props: { entries, domain: 'mail.example.com', anchorFor: () => 'dns-d1' },
			global: { plugins: [createTestI18n()], stubs: { Icon: true } },
		});
		await w.find('[data-testid="dns-copy-zone"]').trigger('click');
		expect(String(copy.mock.calls[0]![0]).split('\n')).toEqual([
			'; Not part of example.com: add the record below at the DNS host for owlat.test. It is commented out so an import into example.com skips it.',
			'; bounces.owlat.test.\t3600\tIN\tMX\t10 mx.owlat.test.',
		]);
	});

	it('asks for every record, without a count or links, before the first check', () => {
		const w = mountSummary(undefined);
		expect(headline(w)).toContain('Add these 4 records at your DNS host');
		expect(w.find('[data-testid="dns-outstanding"]').exists()).toBe(false);
		expect(w.find('[role="progressbar"]').exists()).toBe(false);
		expect(w.find('[data-testid="dns-copy-zone"]').text()).toBe('Copy all records');
	});

	it('says the domain is set up and offers every record once all are found', async () => {
		const w = mountSummary({ spf: ok, dkim: [ok, ok], dmarc: ok });
		expect(headline(w)).toBe('All 4 records found — this domain is set up.');
		expect(w.find('[data-testid="dns-outstanding"]').exists()).toBe(false);
		await w.find('[data-testid="dns-copy-zone"]').trigger('click');
		expect(String(copy.mock.calls[0]![0]).split('\n')).toHaveLength(4);
	});

	it('moves to and focuses the record a link names', async () => {
		const target = document.createElement('div');
		target.id = 'dns-d1-dmarc';
		target.tabIndex = -1;
		target.scrollIntoView = vi.fn();
		document.body.appendChild(target);
		vi.stubGlobal('matchMedia', () => ({ matches: true }));

		const w = mountSummary({ spf: ok, dkim: [ok, ok], dmarc: missing });
		await w.find('[data-testid="dns-outstanding-link"]').trigger('click');
		expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
		expect(document.activeElement).toBe(target);
		target.remove();
	});
});
