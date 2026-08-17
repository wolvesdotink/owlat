// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import DeliverabilityChecklistGroups from '../DeliverabilityChecklistGroups.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.stubGlobal('useI18n', i18nStubs.useI18n);
vi.stubGlobal('useCopyToClipboard', () => ({
	copy: vi.fn(),
	isCopied: vi.fn(() => false),
}));

function groups(itemOverrides: Record<string, unknown> = {}) {
	return [
		{
			key: 'blocking',
			label: 'Blocking delivery',
			description: 'These checks can stop or reject mail.',
			items: [
				{
					id: 'domain.postmaster',
					title: 'Connect Gmail delivery feedback',
					protocol: 'Google Postmaster Tools',
					severity: 'blocking',
					impact: 'Postmaster data shows the spam rate Gmail actually observes for this domain.',
					docsHref: 'https://docs.owlat.app/guide/deliverability',
					dependencies: [],
					dnsBacked: false,
					scope: { kind: 'domain', domainId: 'domain-a', domain: 'example.test' },
					status: 'warn',
					observed: [],
					diagnosticReport: 'No data',
					nextStep: 'Authorize the domain.',
					instructions: {
						providerLabel: 'Google Postmaster Tools',
						summary: 'Authorize receiver feedback.',
						steps: ['Open Google Postmaster Tools.', 'Authorize example.test.'],
					},
					...itemOverrides,
				},
			],
		},
	] as never;
}

function mountGroups(itemOverrides: Record<string, unknown> = {}) {
	return mount(DeliverabilityChecklistGroups, {
		props: { groups: groups(itemOverrides) },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { template: '<i />' },
				UiButton: { template: '<button><slot /></button>' },
				DeliverabilitySetupValues: true,
			},
		},
	});
}

describe('DeliverabilityChecklistGroups', () => {
	it('renders the shared guided flow inside every expanded non-passing row', () => {
		const wrapper = mountGroups();
		expectFullyLocalized(wrapper);
		expect(wrapper.text()).toContain('Verify now');
		expect(wrapper.text()).toContain('Authorize receiver feedback.');
		expect(wrapper.text()).toContain('Open Google Postmaster Tools.');
	});

	/**
	 * The group heading comes from the Convex read model and the check's own
	 * words from `@owlat/shared`; both keep their English there (a stored and
	 * mailed regression alert and a copied diagnostic dump print them), so the
	 * screen renders the catalog copy derived from the severity and the check id.
	 * The failure this catches is the key path painted where the sentence belongs.
	 */
	it('paints the group heading and the check copy from the catalog, never a key path', () => {
		const wrapper = mountGroups();

		expectFullyLocalized(wrapper);
		expect(wrapper.text()).not.toMatch(/sharedPkg\./);
		expect(wrapper.text()).toContain('Blocking delivery');
		expect(wrapper.text()).toContain('These checks can stop or reject mail.');
		expect(wrapper.text()).toContain('Connect Gmail delivery feedback');
		expect(wrapper.text()).toContain(
			'Postmaster data shows the spam rate Gmail actually observes for this domain.'
		);
	});

	/**
	 * A check this bundle's catalog has never heard of — an older tab against a
	 * newer server — must read as the read model's own English rather than the
	 * key path a bare `t()` would have painted at the operator.
	 */
	it("falls back to the payload's words for a check the catalog does not know", () => {
		const wrapper = mountGroups({
			id: 'domain.future_check',
			title: 'A check shipped after this bundle',
			impact: 'Its rationale arrives with it.',
		});

		expect(wrapper.text()).not.toMatch(/sharedPkg\./);
		expect(wrapper.text()).toContain('A check shipped after this bundle');
		expect(wrapper.text()).toContain('Its rationale arrives with it.');
	});
});
