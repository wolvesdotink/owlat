// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeliverabilityDnsRecords from '../DeliverabilityDnsRecords.vue';

const copy = vi.fn(async () => true);
const isCopied = vi.fn(() => false);

beforeEach(() => {
	copy.mockClear();
	isCopied.mockClear();
	vi.stubGlobal('useCopyToClipboard', () => ({ copy, isCopied }));
});

describe('DeliverabilityDnsRecords', () => {
	it.each([
		['name', 'mail.example.com'],
		['type', 'TXT'],
		['value', 'v=spf1 include:spf.owlat.example -all'],
		['ttl', '3600'],
	] as const)('copies the exact %s with a scope-qualified key', async (field, expected) => {
		const wrapper = mount(DeliverabilityDnsRecords, {
			props: {
				scopeKey: 'domain:domain-a:domain.spf',
				records: [
					{
						id: 'domain.spf:0',
						label: 'TXT record',
						name: 'mail.example.com',
						type: 'TXT',
						value: 'v=spf1 include:spf.owlat.example -all',
						ttl: 3600,
					},
				],
			},
			global: { stubs: { Icon: { template: '<i />' } } },
		});

		await wrapper.get(`button[aria-label="Copy ${field} for mail.example.com"]`).trigger('click');
		expect(copy).toHaveBeenCalledWith(expected, `domain:domain-a:domain.spf:domain.spf:0:${field}`);
	});
});
