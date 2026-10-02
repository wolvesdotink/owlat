// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DmarcReadinessPanel from '../DmarcReadinessPanel.vue';
import DmarcSourcesTable from '../DmarcSourcesTable.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const global = {
	plugins: [createTestI18n()],
	stubs: {
		Icon: true,
		UiIconBox: true,
		UiProgressBar: true,
		UiBadge: { template: '<span data-testid="badge"><slot /></span>' },
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		DomainsDNSRecordPanel: {
			props: ['record'],
			template: '<div data-testid="record">{{ record.value }}</div>',
		},
	},
};

const readiness = {
	streakDays: 14,
	requiredDays: 14,
	latestAlignedRate: 1,
	isReady: true,
	currentPolicy: 'none' as const,
	nextPolicy: 'quarantine' as const,
	recommendedRecord: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=quarantine' },
};

describe('DmarcReadinessPanel', () => {
	it('hands over the next record once the domain is ready', () => {
		const wrapper = mount(DmarcReadinessPanel, {
			props: { domain: 'example.com', readiness },
			global,
		});
		expect(wrapper.text()).toContain('Ready for p=quarantine');
		expect(wrapper.find('[data-testid="record"]').text()).toBe('v=DMARC1; p=quarantine');
		expect(wrapper.find('a').attributes('href')).toBe(
			'/dashboard/admin/delivery/domains?domain=example.com'
		);
	});

	it('shows progress and no record while the streak is building', () => {
		const wrapper = mount(DmarcReadinessPanel, {
			props: {
				domain: 'example.com',
				readiness: { ...readiness, streakDays: 5, isReady: false },
			},
			global,
		});
		expect(wrapper.text()).toContain('5 of 14 days at 99% or more');
		expect(wrapper.find('[data-testid="record"]').exists()).toBe(false);
	});

	it('says when the domain is already enforced', () => {
		const wrapper = mount(DmarcReadinessPanel, {
			props: {
				domain: 'example.com',
				readiness: {
					...readiness,
					currentPolicy: 'reject',
					nextPolicy: null,
					recommendedRecord: null,
				},
			},
			global,
		});
		expect(wrapper.text()).toContain('Enforced at p=reject');
	});
});

describe('DmarcSourcesTable', () => {
	it('lists sources with their kind, pass rate and IPs', () => {
		const wrapper = mount(DmarcSourcesTable, {
			props: {
				totalCount: 2,
				sources: [
					{
						key: 'ip:198.51.100.77',
						kind: 'unknown',
						label: '198.51.100.77',
						messageCount: 9,
						alignedCount: 0,
						failingCount: 9,
						dkimAlignedCount: 0,
						spfAlignedCount: 0,
						ipCount: 1,
						topIps: ['198.51.100.77'],
						overrideReasons: [],
					},
					{
						key: 'owlat',
						kind: 'owlat',
						label: 'Owlat',
						messageCount: 412,
						alignedCount: 412,
						failingCount: 0,
						dkimAlignedCount: 412,
						spfAlignedCount: 412,
						ipCount: 2,
						topIps: ['203.0.113.10', '203.0.113.11'],
						overrideReasons: ['forwarded'],
					},
				],
			},
			global,
		});
		const rows = wrapper.findAll('[data-testid="dmarc-source"]');
		expect(rows[0]?.text()).toContain('Unknown');
		expect(rows[0]?.text()).toContain('0.0%');
		expect(rows[1]?.text()).toContain('This Owlat server');
		expect(rows[1]?.text()).toContain('2 IPs: 203.0.113.10, 203.0.113.11');
		expect(rows[1]?.text()).toContain('Receiver notes: forwarded');
	});
});
