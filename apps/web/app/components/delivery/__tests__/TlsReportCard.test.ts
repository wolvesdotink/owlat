// @vitest-environment happy-dom
/**
 * DeliveryTlsReportCard — the Delivery-page card for inbound TLS-RPT (RFC 8460).
 *
 * Prop-driven, so we can assert every state directly:
 *   - loading / error / empty each render their own explicit block;
 *   - a populated summary shows the overall encrypted %, a row per reporting
 *     organization, and a plain-language failure breakdown whose copy is asserted
 *     VERBATIM (the honesty audit: the card may only say what the report said).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TlsReportCard from '../TlsReportCard.vue';
import type { TlsReportSummary } from '~/utils/tlsReportView';

function mountCard(props: {
	summary?: TlsReportSummary | null;
	isLoading?: boolean;
	error?: unknown;
}) {
	return mount(TlsReportCard, {
		props: {
			summary: props.summary ?? null,
			isLoading: props.isLoading ?? false,
			error: props.error,
		},
	});
}

const populated: TlsReportSummary = {
	windowDays: 30,
	reportCount: 2,
	totalSuccessCount: 190,
	totalFailureCount: 10,
	overallSuccessRate: 190 / 200,
	reportingOrganizations: [
		{
			organizationName: 'Google',
			successCount: 100,
			failureCount: 10,
			successRate: 100 / 110,
			reportCount: 1,
		},
		{
			organizationName: 'Microsoft',
			successCount: 90,
			failureCount: 0,
			successRate: 1,
			reportCount: 1,
		},
	],
	failureTypeCounts: [
		{ type: 'starttls-not-supported', count: 8 },
		{ type: 'certificate-host-mismatch', count: 2 },
	],
	trend: [{ date: '2026-07-11', successCount: 190, failureCount: 10 }],
};

describe('DeliveryTlsReportCard', () => {
	it('renders the loading state', () => {
		const w = mountCard({ isLoading: true });
		expect(w.find('[data-testid="tls-report-loading"]').exists()).toBe(true);
		expect(w.find('[data-testid="tls-report-body"]').exists()).toBe(false);
	});

	it('renders the error state', () => {
		const w = mountCard({ error: new Error('boom') });
		expect(w.find('[data-testid="tls-report-error"]').exists()).toBe(true);
	});

	it('renders the empty state when no reports have arrived', () => {
		const empty: TlsReportSummary = {
			windowDays: 30,
			reportCount: 0,
			totalSuccessCount: 0,
			totalFailureCount: 0,
			overallSuccessRate: null,
			reportingOrganizations: [],
			failureTypeCounts: [],
			trend: [],
		};
		const w = mountCard({ summary: empty });
		expect(w.find('[data-testid="tls-report-empty"]').exists()).toBe(true);
		expect(w.find('[data-testid="tls-report-body"]').exists()).toBe(false);
	});

	it('renders the overall rate, one row per reporter, and plain-language failures', () => {
		const w = mountCard({ summary: populated });
		expect(w.find('[data-testid="tls-report-body"]').exists()).toBe(true);

		// Overall encrypted percentage (190/200 = 95%).
		expect(w.find('[data-testid="tls-report-overall"]').text()).toContain('95%');

		// One row per reporting organization.
		const reporters = w.findAll('[data-testid="tls-report-reporter"]');
		expect(reporters).toHaveLength(2);
		expect(reporters[0]!.text()).toContain('Google');
		expect(reporters[1]!.text()).toContain('100%');

		// Failure breakdown uses the agreed plain-language copy, verbatim.
		const failures = w.findAll('[data-testid="tls-report-failure"]');
		expect(failures).toHaveLength(2);
		expect(failures[0]!.text()).toContain('STARTTLS stripped upstream');
		expect(failures[1]!.text()).toContain("Certificate didn't match the server name");
	});
});
