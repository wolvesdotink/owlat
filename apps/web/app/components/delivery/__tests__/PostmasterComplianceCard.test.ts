// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PostmasterComplianceCard from '../PostmasterComplianceCard.vue';

const stubs = {
	Icon: { template: '<i />' },
	UiCard: { template: '<div><slot /></div>' },
	UiIconBox: { template: '<i />' },
};

interface CardProps {
	status:
		| {
				connected: boolean;
				domains: Array<{
					domain: string;
					periodStart: number | null;
					compliancePeriodStart: number | null;
					cards: Array<{
						id: string;
						severity: 'critical' | 'warning' | 'info';
						title: string;
						detail: string;
						remedy: string;
						check: string;
					}>;
				}>;
		  }
		| null
		| undefined;
	isLoading: boolean;
}

function mountCard(props: CardProps) {
	return mount(PostmasterComplianceCard, { props, global: { stubs } });
}

const failingCard = {
	id: 'check:IP_REPUTATION',
	severity: 'critical' as const,
	title: 'Gmail rates the sending IP badly',
	detail: 'Google Postmaster reports the IP_REPUTATION compliance check as failing for a.example.',
	remedy: 'Check the IP against the blocklists on the delivery page, slow the warm-up.',
	check: 'IP_REPUTATION',
};

describe('PostmasterComplianceCard', () => {
	it('renders a failing check as a card naming the check and the remedy', () => {
		const wrapper = mountCard({
			isLoading: false,
			status: {
				connected: true,
				domains: [
					{
						domain: 'a.example',
						periodStart: Date.UTC(2026, 6, 20),
						compliancePeriodStart: Date.UTC(2026, 6, 21),
						cards: [failingCard],
					},
				],
			},
		});

		const card = wrapper.find('[data-testid="postmaster-card"]');
		expect(card.exists()).toBe(true);
		expect(card.attributes('data-check')).toBe('IP_REPUTATION');
		expect(card.text()).toContain('Gmail rates the sending IP badly');
		expect(wrapper.find('[data-testid="postmaster-card-remedy"]').text()).toContain(
			'slow the warm-up'
		);
		expect(wrapper.text()).toContain('a.example');
		expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(false);
	});

	it('shows a calm "not connected" affordance rather than an error or a nag', () => {
		const wrapper = mountCard({
			isLoading: false,
			status: { connected: false, domains: [] },
		});

		const notConnected = wrapper.find('[data-testid="postmaster-not-connected"]');
		expect(notConnected.exists()).toBe(true);
		expect(notConnected.text()).toContain('Not connected');
		expect(notConnected.text()).toContain('measurement confidence');
		expect(wrapper.text()).not.toMatch(/error|failed|required|incomplete|action needed/i);
		expect(wrapper.find('[data-testid="postmaster-card"]').exists()).toBe(false);
	});

	it('treats an absent query result as not connected, never as a failure', () => {
		for (const status of [null, undefined]) {
			const wrapper = mountCard({ isLoading: false, status });
			expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(true);
		}
	});

	it('says everything is clear when connected with no failing checks', () => {
		const wrapper = mountCard({
			isLoading: false,
			status: {
				connected: true,
				domains: [
					{
						domain: 'a.example',
						periodStart: Date.UTC(2026, 6, 20),
						compliancePeriodStart: null,
						cards: [],
					},
				],
			},
		});

		expect(wrapper.find('[data-testid="postmaster-all-clear"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="postmaster-card"]').exists()).toBe(false);
	});

	it('renders a loading placeholder instead of a premature verdict', () => {
		const wrapper = mountCard({ isLoading: true, status: undefined });

		expect(wrapper.find('[data-testid="postmaster-loading"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="postmaster-not-connected"]').exists()).toBe(false);
	});
});
