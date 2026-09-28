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

	it('explains an unmeasured check and links to the Blocklist lookups card', () => {
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
							dailyCap: 50,
							active: false,
							blockReasons: ['dnsbl'],
							dnsbl: 'unknown',
							dnsblUnknownReason: 'resolver_refused',
							dnsblListings: [],
							fcrdns: {
								ehlo: 'mail.example.com',
								ptrNames: ['mail.example.com'],
								verdict: 'pass',
								isGenericPtr: false,
								isOverridden: false,
							},
						},
					],
				},
				volume: { dailySendCount: 0 },
			},
			global: {
				stubs: {
					Icon: { template: '<i />' },
					UiCard: { template: '<div><slot /></div>' },
					NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				},
			},
		});
		const text = wrapper.text();
		expect(text).toContain('Spamhaus refused the blocklist check');
		expect(text).toContain("Owlat won't send from this IP until a check succeeds.");
		expect(text).not.toContain('request delisting');
		const link = wrapper.find('[data-testid="sending-details-blocklist-lookups"]');
		expect(link.text()).toContain('Open blocklist lookups');
		expect(link.attributes('href')).toBe('/dashboard/admin/delivery/transport#blocklist-lookups');
	});
});
