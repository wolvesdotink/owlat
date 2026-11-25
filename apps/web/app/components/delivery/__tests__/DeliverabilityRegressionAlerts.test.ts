import type { Id } from '@owlat/api/dataModel';
import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
	DeliverabilityChecklistGroup,
	DeliverabilityRegressionAlert,
	DeliverabilitySendingHold,
} from '~/utils/deliverabilityCenter';
import DeliverabilityRegressionAlerts from '../DeliverabilityRegressionAlerts.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

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
	channels: {
		email: { state: 'sent', isOnAffectedTransport: false },
		inAppCount: 2,
		push: { delivered: 1, failed: 0, held: 0 },
		webhook: null,
	},
};
const stubs = {
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
		global: { plugins: [createTestI18n()], stubs },
	});
}

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

describe('DeliverabilityRegressionAlerts', () => {
	it('prominently names the failed check, domain, evidence time, and regression', () => {
		const wrapper = mountAlerts();

		expectFullyLocalized(wrapper);
		// The named check is `@owlat/shared` English (Convex stores and mails the
		// alert with it), so the heading resolves the catalog copy from the id.
		expect(wrapper.text()).not.toMatch(/sharedPkg\./);
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

	it('names every channel that carried the alert', () => {
		const wrapper = mountAlerts();
		expect(wrapper.get('[data-testid="alert-channels"]').text()).toBe(
			'Email · In app to 2 people · Push on 1 device'
		);
		expect(wrapper.find('[data-testid="alert-email-may-not-arrive"]').exists()).toBe(false);
	});

	it('never reads as delivered by email when the alert is about the server the email leaves from', () => {
		const wrapper = mountAlerts({
			itemId: 'deployment.port25',
			channels: {
				email: { state: 'sent', isOnAffectedTransport: true },
				inAppCount: 1,
				push: { delivered: 0, failed: 1, held: 1 },
				webhook: null,
			},
		});
		expectFullyLocalized(wrapper);
		const line = wrapper.get('[data-testid="alert-channels"]').text();
		expect(line).toBe(
			'Email, handed to the affected server · In app to 1 person · Push held for quiet hours on 1 device · Push failed on 1 device'
		);
		expect(wrapper.get('[data-testid="alert-email-may-not-arrive"]').text()).toContain(
			'the email may not arrive'
		);
	});

	it('says when the email did not go out and nobody has the alert switched on', () => {
		const wrapper = mountAlerts({
			channels: {
				email: { state: 'unavailable', isOnAffectedTransport: false },
				inAppCount: 0,
				push: { delivered: 0, failed: 0, held: 0 },
				webhook: { delivered: 0, failed: 0, pending: 0 },
			},
		});
		expect(wrapper.get('[data-testid="alert-channels"]').text()).toBe(
			'Email not sent · In app to nobody, everyone switched it off'
		);
	});

	it('names the alert webhook deliveries by outcome', () => {
		const wrapper = mountAlerts({
			channels: {
				email: { state: 'sent', isOnAffectedTransport: false },
				inAppCount: 2,
				push: { delivered: 0, failed: 0, held: 0 },
				webhook: { delivered: 1, failed: 1, pending: 1 },
			},
		});
		expectFullyLocalized(wrapper);
		expect(wrapper.get('[data-testid="alert-channels"]').text()).toBe(
			'Email · In app to 2 people · Webhook to 1 endpoint · Webhook still sending to 1 endpoint · Webhook failed on 1 endpoint'
		);
	});

	describe('a sending hold', () => {
		const hold: DeliverabilitySendingHold = {
			alertId: 'sending_hold:1000',
			holdStatus: 'banned',
			previousHoldStatus: 'suspended',
			reason: 'Phishing reported',
			observedAt: Date.UTC(2026, 6, 26, 11),
			channels: {
				email: { state: 'sent', isOnAffectedTransport: true },
				inAppCount: 2,
				push: { delivered: 0, failed: 0, held: 0 },
				webhook: { delivered: 1, failed: 0, pending: 0 },
			},
		};

		function mountHold(alerts: DeliverabilityRegressionAlert[] = []) {
			return mount(DeliverabilityRegressionAlerts, {
				props: { alerts, sendingHold: hold, groups },
				global: { plugins: [createTestI18n()], stubs },
			});
		}

		it('lists the hold with what each channel did, and nothing to acknowledge', () => {
			const wrapper = mountHold();
			expectFullyLocalized(wrapper);
			expect(wrapper.text()).toContain('Sending is stopped');
			const article = wrapper.get('[data-testid="sending-hold-alert"]');
			expect(article.text()).toContain('Sending banned');
			expect(article.text()).toContain('It was suspended before.');
			expect(article.text()).toContain('Phishing reported');
			expect(article.get('[data-testid="alert-channels"]').text()).toBe(
				'Email, handed to the affected server · In app to 2 people · Webhook to 1 endpoint'
			);
			expect(article.find('[data-testid="alert-email-may-not-arrive"]').exists()).toBe(true);
			expect(wrapper.text()).not.toContain('Acknowledge');
			expect(wrapper.text()).not.toContain('Resolve alert');
		});

		it('keeps the regression heading when checks regressed too', () => {
			const wrapper = mountHold([alert]);
			expect(wrapper.text()).toContain('Deliverability regression detected');
			expect(wrapper.findAll('article')).toHaveLength(2);
		});
	});
});
