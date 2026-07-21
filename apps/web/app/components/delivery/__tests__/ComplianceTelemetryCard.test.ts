// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ComplianceTelemetryCard from '../ComplianceTelemetryCard.vue';

const stubs = {
	UiCard: { template: '<div><slot /></div>' },
	UiIconBox: { template: '<i />' },
};

function telemetryFixture() {
	return {
		spamRate: {
			spamRate: null as number | null,
			totalDelivered: 0,
			totalComplaints: 0,
			status: 'no_data' as 'no_data' | 'on_target' | 'elevated' | 'hard_limit',
			cleanInternalDaysBelowHardThreshold: 0,
			hasRequiredInternalCleanDayEvidence: false,
			target: 0.001,
			hardThreshold: 0.003,
			internalCleanDaysRequired: 7,
		},
		gmail: {
			domains: [] as Array<{ primaryDomain: string; delivered24h: number }>,
			domainLimit: 100,
			isDomainListTruncated: false,
			highestVolumeDomain: null as { primaryDomain: string; delivered24h: number } | null,
			warningThreshold: 4_000,
			bulkSenderThreshold: 5_000,
			approachingBulkClassification: false,
			windowApproximationMinutes: 60,
		},
		unsubscribe: {
			p95Ms: null as number | null,
			sampleCount: 0,
			exceedsHonorWindow: false,
			honorWindowMs: 48 * 60 * 60 * 1_000,
		},
	};
}

function mountCard(telemetry: ReturnType<typeof telemetryFixture> | null, isLoading = false) {
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(telemetry),
		isLoading: ref(isLoading),
	}));
	return mount(ComplianceTelemetryCard, { global: { stubs } });
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('ComplianceTelemetryCard', () => {
	it('renders a loading state without inventing telemetry', () => {
		const wrapper = mountCard(null, true);
		expect(wrapper.find('[data-testid="compliance-loading"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="spam-rate"]').exists()).toBe(false);
	});

	it('renders honest no-data states', () => {
		const wrapper = mountCard(telemetryFixture());
		expect(wrapper.find('[data-testid="spam-rate"]').text()).toContain('No data');
		expect(wrapper.find('[data-testid="gmail-proximity"]').text()).toContain(
			'No MTA-observed Gmail traffic'
		);
		expect(wrapper.find('[data-testid="unsubscribe-latency"]').text()).toContain('Collecting data');
	});

	it.each([
		['on_target', 'On target', 'border-success/40'],
		['elevated', 'Above target', 'border-warning/40'],
		['hard_limit', 'At hard line', 'border-error/40'],
	] as const)('renders the %s spam-rate state', (status, label, toneClass) => {
		const telemetry = telemetryFixture();
		telemetry.spamRate.status = status;
		telemetry.spamRate.spamRate =
			status === 'on_target' ? 0.0005 : status === 'elevated' ? 0.002 : 0.003;
		const card = mountCard(telemetry).find('[data-testid="spam-rate"]');
		expect(card.text()).toContain(label);
		expect(card.classes()).toContain(toneClass);
	});

	it('shows the 4,000-message proximity warning', () => {
		const telemetry = telemetryFixture();
		telemetry.gmail.highestVolumeDomain = {
			primaryDomain: 'example.com',
			delivered24h: 4_000,
		};
		telemetry.gmail.domains = [telemetry.gmail.highestVolumeDomain];
		telemetry.gmail.approachingBulkClassification = true;
		const card = mountCard(telemetry).find('[data-testid="gmail-proximity"]');
		expect(card.classes()).toContain('border-warning/40');
		expect(card.text()).toContain('approaching permanent Gmail bulk-sender classification');
	});

	it('discloses when the indexed primary-domain list is capped', () => {
		const telemetry = telemetryFixture();
		telemetry.gmail.isDomainListTruncated = true;
		expect(mountCard(telemetry).text()).toContain(
			'Showing the 100 highest-volume primary domains.'
		);
	});

	it('renders internal clean-day evidence without claiming Google eligibility', () => {
		const telemetry = telemetryFixture();
		telemetry.spamRate.cleanInternalDaysBelowHardThreshold = 6;
		let progress = mountCard(telemetry).find('[data-testid="spam-recovery-progress"]');
		expect(progress.text()).toContain('6 / 7 clean active days in Owlat data');
		expect(progress.text()).not.toContain('evidence complete');

		telemetry.spamRate.cleanInternalDaysBelowHardThreshold = 7;
		telemetry.spamRate.hasRequiredInternalCleanDayEvidence = true;
		progress = mountCard(telemetry).find('[data-testid="spam-recovery-progress"]');
		expect(progress.text().replace(/\s+/g, ' ')).toContain(
			'7 / 7 clean active days in Owlat data · evidence complete'
		);
		expect(progress.classes()).toContain('text-text-secondary');
		const cardText = mountCard(telemetry).text();
		expect(cardText).toContain('not Google mitigation eligibility');
		expect(cardText).toContain('Verify Postmaster Tools');
	});

	it('renders the unsubscribe honor-window alert', () => {
		const telemetry = telemetryFixture();
		telemetry.unsubscribe.p95Ms = 7 * 24 * 60 * 60 * 1_000;
		telemetry.unsubscribe.sampleCount = 20;
		telemetry.unsubscribe.exceedsHonorWindow = true;
		const card = mountCard(telemetry).find('[data-testid="unsubscribe-latency"]');
		expect(card.classes()).toContain('border-error/40');
		expect(card.text()).toContain('20 requests');
		expect(card.find('.text-error').text()).toContain('honored within 48 hours');
	});
});
