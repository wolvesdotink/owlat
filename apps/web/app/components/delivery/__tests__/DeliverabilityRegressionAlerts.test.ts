// @vitest-environment happy-dom
import type { Id } from '@owlat/api/dataModel';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type {
	DeliverabilityChecklistGroup,
	DeliverabilityRegressionAlert,
} from '~/utils/deliverabilityCenter';
import DeliverabilityRegressionAlerts from '../DeliverabilityRegressionAlerts.vue';

const domainId = 'domain-a' as Id<'domains'>;
const alertId = 'alert-a' as Id<'deliverabilityRegressionAlerts'>;
const groups: DeliverabilityChecklistGroup[] = [
	{
		key: 'blocking',
		label: 'Blocking delivery',
		description: 'Checks that can stop mail.',
		items: [
			{
				id: 'domain.dkim',
				title: 'Sign your emails so Gmail trusts them',
				protocol: 'DKIM',
				severity: 'blocking',
				impact: 'Signing proves the message belongs to this domain.',
				docsHref: '/guide/deliverability',
				dependencies: [],
				dnsBacked: true,
				scope: { kind: 'domain', domainId, domain: 'example.com' },
				status: 'fail',
				observed: ['signature missing'],
				diagnosticReport: 'No valid DKIM signature was observed.',
			},
		],
	},
];
const alert: DeliverabilityRegressionAlert = {
	id: alertId,
	itemId: 'domain.dkim',
	domainId,
	domain: 'example.com',
	message: 'DKIM changed from pass to fail.',
	observedAt: Date.UTC(2026, 6, 26, 11),
	acknowledgedAt: null,
	emailNotificationState: 'sent',
};
const stubs = {
	Icon: { template: '<i />' },
	UiButton: {
		props: ['disabled', 'loading'],
		emits: ['click'],
		template:
			'<button :disabled="disabled" :aria-busy="loading" @click="$emit(\'click\')"><slot name="iconLeft" /><slot /></button>',
	},
	UiIconBox: { template: '<i />' },
};

function mountAlerts(overrides: Partial<DeliverabilityRegressionAlert> = {}) {
	return mount(DeliverabilityRegressionAlerts, {
		props: { alerts: [{ ...alert, ...overrides }], groups },
		global: { stubs },
	});
}

describe('DeliverabilityRegressionAlerts', () => {
	it('prominently names the failed check, domain, evidence time, and regression', () => {
		const wrapper = mountAlerts();

		expect(wrapper.text()).toContain('Deliverability regression detected');
		expect(wrapper.text()).toContain('Sign your emails so Gmail trusts them');
		expect(wrapper.text()).toContain('example.com');
		expect(wrapper.text()).toContain('DKIM changed from pass to fail.');
		expect(wrapper.get('time').attributes('datetime')).toBe('2026-07-26T11:00:00.000Z');
	});

	it('emits direct-open, acknowledge, and resolve controls for the exact alert', async () => {
		const wrapper = mountAlerts();
		const buttons = wrapper.findAll('button');
		await buttons.find((button) => button.text().includes('Open check'))!.trigger('click');
		await buttons.find((button) => button.text().includes('Acknowledge'))!.trigger('click');
		await buttons.find((button) => button.text().includes('Resolve alert'))!.trigger('click');

		expect(wrapper.emitted('view')).toEqual([[alert]]);
		expect(wrapper.emitted('acknowledge')).toEqual([[alert]]);
		expect(wrapper.emitted('resolve')).toEqual([[alert]]);
	});

	it('does not offer acknowledgment again after it has been recorded', () => {
		const wrapper = mountAlerts({ acknowledgedAt: Date.UTC(2026, 6, 26, 11, 30) });
		expect(wrapper.text()).toContain('Acknowledged');
		expect(wrapper.findAll('button').some((button) => button.text() === 'Acknowledge')).toBe(false);
		expect(wrapper.text()).toContain('Resolve alert');
	});
});
