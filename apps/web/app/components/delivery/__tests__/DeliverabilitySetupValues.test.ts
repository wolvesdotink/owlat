// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeliverabilitySetupValues from '../DeliverabilitySetupValues.vue';

const copy = vi.fn(async () => true);
const isCopied = vi.fn(() => false);

beforeEach(() => {
	copy.mockClear();
	isCopied.mockClear();
	vi.stubGlobal('useCopyToClipboard', () => ({ copy, isCopied }));
});

describe('DeliverabilitySetupValues', () => {
	it.each([
		['name', 'name', 'mail.example.com'],
		['recordType', 'type', 'TXT'],
		['value', 'value', 'v=spf1 include:spf.owlat.example -all'],
		['ttl', 'ttl', '3600'],
	] as const)(
		'copies the exact %s with a scope-qualified key',
		async (field, ariaField, expected) => {
			const wrapper = mount(DeliverabilitySetupValues, {
				props: {
					scopeKey: 'domain:domain-a:domain.spf',
					setupValues: [
						{
							kind: 'dns_record',
							id: 'domain.spf:0',
							label: 'TXT record',
							name: 'mail.example.com',
							recordType: 'TXT',
							value: 'v=spf1 include:spf.owlat.example -all',
							ttl: 3600,
						},
					],
				},
				global: { stubs: { Icon: { template: '<i />' } } },
			});

			await wrapper
				.get(`button[aria-label="Copy ${ariaField} for mail.example.com"]`)
				.trigger('click');
			expect(copy).toHaveBeenCalledWith(
				expected,
				`domain:domain-a:domain.spf:domain.spf:0:${field}`
			);
		}
	);

	it('renders additive SPF mechanisms without fake DNS record fields', async () => {
		const wrapper = mount(DeliverabilitySetupValues, {
			props: {
				scopeKey: 'deployment:deployment.ipv6_spf',
				setupValues: [
					{
						kind: 'spf_mechanisms',
						id: 'deployment.ipv6_spf:0',
						label: 'SPF mechanisms to add',
						domain: 'bounce.example.test',
						mechanisms: ['ip6:2001:db8::1', 'ip6:2001:db8::2'],
						instruction:
							'Add these mechanisms before the terminal all mechanism. Do not publish a second SPF record.',
					},
				],
			},
			global: { stubs: { Icon: { template: '<i />' } } },
		});

		expect(wrapper.text()).toContain('Do not publish a second SPF record.');
		expect(wrapper.text()).toContain('ip6:2001:db8::1 ip6:2001:db8::2');
		expect(wrapper.text()).not.toContain('TXT fragment');
		expect(wrapper.text()).not.toContain('TTL');
		await wrapper
			.get('button[aria-label="Copy mechanisms for bounce.example.test"]')
			.trigger('click');
		expect(copy).toHaveBeenCalledWith(
			'ip6:2001:db8::1 ip6:2001:db8::2',
			'deployment:deployment.ipv6_spf:deployment.ipv6_spf:0:mechanisms'
		);
	});

	it('renders an SMTP setting without pretending it is DNS', () => {
		const wrapper = mount(DeliverabilitySetupValues, {
			props: {
				scopeKey: 'deployment:deployment.ehlo_ptr',
				setupValues: [
					{
						kind: 'smtp_setting',
						id: 'deployment.ehlo_ptr:0',
						label: 'SMTP EHLO hostname',
						setting: 'ehlo_hostname',
						value: 'mail.example.test',
					},
				],
			},
			global: { stubs: { Icon: { template: '<i />' } } },
		});

		expect(wrapper.text()).toContain('EHLO hostname');
		expect(wrapper.text()).not.toContain('TTL');
		expect(wrapper.text()).not.toContain('TXT');
	});
});
