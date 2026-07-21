// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import DomainTable from '../DomainTable.vue';

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { template: '<a><slot /></a>' },
	UiCard: { template: '<div><slot /></div>' },
	UiIconBox: { template: '<i />' },
};

function domainRow(cleanDaysBelowHardThreshold: number) {
	return {
		domain: 'example.com',
		status: 'verified' as const,
		auth: { spf: true, dkim: true, dmarc: true },
		missing: [],
		sent30d: 1_000,
		riskLevel: 'critical' as const,
		bounceRate: 0,
		complaintRate: 0.003,
		spamRate: 0.003,
		spamRateStatus: 'hard_limit' as const,
		delivered30d: 1_000,
		complaints30d: 3,
		cleanDaysBelowHardThreshold,
	};
}

describe('DomainTable recovery progress', () => {
	it('shows per-domain clean-day progress and eligibility tone', () => {
		let wrapper = mount(DomainTable, {
			props: { rows: [domainRow(6)] },
			global: { stubs },
		});
		let recovery = wrapper.find('[data-testid="domain-spam-recovery"]');
		expect(recovery.text().replace(/\s+/g, ' ')).toContain('Recovery 6 / 7 clean days');
		expect(recovery.classes()).toContain('text-text-secondary');

		wrapper = mount(DomainTable, {
			props: { rows: [domainRow(7)] },
			global: { stubs },
		});
		recovery = wrapper.find('[data-testid="domain-spam-recovery"]');
		expect(recovery.text().replace(/\s+/g, ' ')).toContain('Recovery 7 / 7 clean days');
		expect(recovery.classes()).toContain('text-success');
	});
});
