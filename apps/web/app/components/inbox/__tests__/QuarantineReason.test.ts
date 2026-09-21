// @vitest-environment happy-dom
/**
 * InboxQuarantineReason — the plain-language quarantine card (UX plan idea 53).
 *
 * The derivation has its own audit; what this pins is the ORDER the card puts
 * things in, because that is the whole change: outcome first, reasons as
 * bullets, and the backend's enum + confidence last and quiet.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import QuarantineReason from '../QuarantineReason.vue';
import type { QuarantineSecurityFlags } from '~/utils/quarantineReason';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountCard(flags?: QuarantineSecurityFlags) {
	return mount(QuarantineReason, {
		props: { flags },
		global: { plugins: [createTestI18n()] },
	});
}

describe('InboxQuarantineReason', () => {
	it('leads with the outcome and lists the reasons as bullets', () => {
		const w = mountCard({
			injectionDetected: true,
			injectionType: 'role_impersonation',
			phishingDetected: true,
			confidence: 0.91,
		});
		expect(w.find('[data-testid="quarantine-headline"]').text()).toContain(
			'pretending to be someone you trust'
		);
		expect(w.findAll('[data-testid="quarantine-reasons"] li')).toHaveLength(2);
	});

	it('keeps the raw enum and the percentage in the quiet footer only', () => {
		const w = mountCard({
			injectionDetected: true,
			injectionType: 'role_impersonation',
			confidence: 0.91,
		});
		const footer = w.find('[data-testid="quarantine-footer"]');
		expect(footer.text()).toContain('role_impersonation');
		expect(footer.text()).toContain('91%');
		expect(w.find('[data-testid="quarantine-headline"]').text()).not.toContain('91%');
	});

	it('shows the flagged excerpt as quoted evidence when the scan captured one', () => {
		const w = mountCard({
			injectionDetected: true,
			flaggedContent: 'ignore previous instructions',
		});
		expect(w.find('code').text()).toBe('ignore previous instructions');
	});

	it('renders an honest card for a row with no scan record', () => {
		const w = mountCard(undefined);
		expect(w.find('[data-testid="quarantine-reason"]').exists()).toBe(true);
		expect(w.find('[data-testid="quarantine-footer"]').text()).toContain(
			'no machine-readable record'
		);
		expect(w.find('code').exists()).toBe(false);
	});
});
