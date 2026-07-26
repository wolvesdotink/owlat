// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import DeliverabilityChecklistGroups from '../DeliverabilityChecklistGroups.vue';

vi.stubGlobal('useCopyToClipboard', () => ({
	copy: vi.fn(),
	isCopied: vi.fn(() => false),
}));

describe('DeliverabilityChecklistGroups', () => {
	it('renders the shared guided flow inside every expanded non-passing row', () => {
		const wrapper = mount(DeliverabilityChecklistGroups, {
			props: {
				groups: [
					{
						key: 'blocking',
						label: 'Blocking delivery',
						description: 'Required',
						items: [
							{
								id: 'domain.postmaster',
								title: 'Connect feedback',
								protocol: 'Google Postmaster Tools',
								severity: 'blocking',
								impact: 'See receiver feedback.',
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
							},
						],
					},
				] as never,
			},
			global: {
				stubs: {
					Icon: { template: '<i />' },
					UiButton: { template: '<button><slot /></button>' },
					DeliverabilitySetupValues: true,
				},
			},
		});
		expect(wrapper.text()).toContain('Authorize receiver feedback.');
		expect(wrapper.text()).toContain('Open Google Postmaster Tools.');
	});
});
