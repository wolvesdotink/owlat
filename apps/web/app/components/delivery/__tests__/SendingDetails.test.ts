// @vitest-environment happy-dom
/**
 * The outbound-IP panel on the sending-domains page: the quarantine reason an
 * operator needs to remediate, and one runbook link per active blocklist.
 */
import { describe, it, expect } from 'vitest';
import { config, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import SendingDetails from '../SendingDetails.vue';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
config.global.plugins = [...(config.global.plugins ?? []), createTestI18n()];

describe('SendingDetails', () => {
	it('shows the exact quarantine reason operators need to remediate', () => {
		const wrapper = mount(SendingDetails, {
			props: {
				warming: {
					syncedAt: Date.now(),
					ips: [
						{
							ip: '203.0.113.10',
							pool: 'transactional',
							currentDay: 1,
							sentToday: 0,
							dailyCap: 100,
							active: false,
							blockReasons: ['fcrdns'],
							dnsbl: 'clean',
							fcrdns: {
								ehlo: 'mail.example.com',
								ptrNames: [],
								verdict: 'fail',
								isGenericPtr: false,
								isOverridden: false,
								reason: 'no-ptr',
							},
						},
					],
				},
				volume: { dailySendCount: 0 },
			},
			global: { stubs: { UiCard: { template: '<div><slot /></div>' } } },
		});
		expect(wrapper.text()).toContain('Identity quarantined');
		expect(wrapper.text()).toContain('No PTR record exists');
		expect(wrapper.text()).toContain('mail.example.com');
	});

	it('deep-links each active blocklist warning to its provider runbook', () => {
		const wrapper = mount(SendingDetails, {
			props: {
				warming: {
					syncedAt: Date.now(),
					ips: [
						{
							ip: '203.0.113.10',
							pool: 'campaign',
							currentDay: 2,
							sentToday: 10,
							dailyCap: 100,
							active: true,
							blockReasons: [],
							dnsbl: 'degraded',
							dnsblListings: ['barracuda', 'abusix'],
						},
					],
				},
				volume: { dailySendCount: 10 },
			},
			global: {
				stubs: {
					Icon: { template: '<i />' },
					UiCard: { template: '<div><slot /></div>' },
				},
			},
		});
		const links = wrapper.findAll('a');
		expect(links.map((link) => link.text())).toEqual([
			'Barracuda recovery steps',
			'Abusix recovery steps',
		]);
		expect(links[0]?.attributes('href')).toContain('/developer/dnsbl-delisting#barracuda');
	});
});
