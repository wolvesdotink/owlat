// @vitest-environment happy-dom
/**
 * ReceivingDnsSection — the inbound (MX) guidance panel on the Sending Domains
 * page. Verifies the section renders the MX record guidance in BOTH the
 * inbound-enabled and not-yet-enabled states, so an admin setting up receiving
 * can always find the instructions (no chicken-and-egg where the guidance is
 * hidden behind the very flag they're trying to turn on).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';

// `useBackendOperation` is a Nuxt auto-import the SFC references as a bare
// global; stub it at module top-level so it is in place before `mount()`
// triggers the component's `setup()` and the reverse-DNS preflight is inert. The
// component only destructures `run`, so that is all the stub needs to expose.
vi.stubGlobal('useBackendOperation', () => ({
	run: vi.fn(async () => undefined),
}));

// The MTA-STS guidance query + runtime config are also bare auto-imports. Mutable
// backing values so individual tests can turn a published policy on/off.
let mtaStsPolicyId: string | null = null;
let siteUrl = '';
vi.stubGlobal('useConvexQuery', () => ({ data: ref({ policyId: mtaStsPolicyId }) }));
vi.stubGlobal('useRuntimeConfig', () => ({ public: { siteUrl } }));

// `useMtaStsVerification` is a Nuxt auto-import the SFC references as a bare
// global; the record-row assertions don't depend on the live verdict, so an
// inert stub is honest here.
vi.stubGlobal('useMtaStsVerification', () => ({
	verification: ref(undefined),
	checked: ref(false),
}));

beforeEach(() => {
	mtaStsPolicyId = null;
	siteUrl = '';
});

import ReceivingDnsSection from '../ReceivingDnsSection.vue';

const stubs = {
	Icon: { template: '<i />' },
	// The copyable record panel is exercised by its own test; render an inert
	// stub that still exposes the derived record for assertions.
	DomainsDNSRecordPanel: {
		props: ['record', 'label', 'domain'],
		template: '<div data-testid="dns-record" :data-value="record.value" />',
	},
	NuxtLink: {
		props: ['to'],
		template: '<a :href="to"><slot /></a>',
	},
};

function mountSection(inboundEnabled: boolean) {
	return mount(ReceivingDnsSection, {
		props: {
			domain: 'example.com',
			mailHost: 'mail.owlat.test',
			inboundPort: 25,
			inboundEnabled,
		},
		global: { stubs },
	});
}

describe('ReceivingDnsSection', () => {
	it('renders MX guidance when inbound is enabled', () => {
		const w = mountSection(true);
		// The MX record derived from the domain + mail host is shown.
		const record = w.find('[data-testid="dns-record"]');
		expect(record.exists()).toBe(true);
		expect(record.attributes('data-value')).toBe('mail.owlat.test');
		// No "not turned on yet" banner in the enabled state.
		expect(w.find('[data-testid="receiving-not-enabled"]').exists()).toBe(false);
		// The intro copy always explains how to receive mail.
		expect(w.text()).toContain('publish the MX record below');
	});

	it('renders MX guidance AND the enable path when inbound is not enabled', () => {
		const w = mountSection(false);
		// Guidance is still present — this is the whole point of the piece.
		const record = w.find('[data-testid="dns-record"]');
		expect(record.exists()).toBe(true);
		expect(record.attributes('data-value')).toBe('mail.owlat.test');
		// Honest "not turned on yet" state with the enable path to Features.
		const banner = w.find('[data-testid="receiving-not-enabled"]');
		expect(banner.exists()).toBe(true);
		expect(banner.text()).toContain("Receiving isn't turned on yet");
		expect(banner.find('a').attributes('href')).toBe('/dashboard/settings/features');
	});

	it('does not render MTA-STS records when no policy is published', () => {
		const w = mountSection(true);
		// Only the MX record — no _mta-sts / mta-sts rows.
		expect(w.text()).not.toContain('Require encryption (MTA-STS)');
	});

	it('renders the _mta-sts TXT + mta-sts CNAME records when a policy is published', () => {
		mtaStsPolicyId = 'abcd1234abcd1234';
		siteUrl = 'https://acme.owlat.app';
		const w = mountSection(true);
		expect(w.text()).toContain('Require encryption (MTA-STS)');
		const values = w.findAll('[data-testid="dns-record"]').map((n) => n.attributes('data-value'));
		expect(values).toContain('v=STSv1; id=abcd1234abcd1234');
		expect(values).toContain('acme.owlat.app');
	});

	it('renders nothing when there is no mail host to point at', () => {
		const w = mount(ReceivingDnsSection, {
			props: { domain: 'example.com', mailHost: null, inboundPort: 25, inboundEnabled: true },
			global: { stubs },
		});
		expect(w.find('[data-testid="dns-record"]').exists()).toBe(false);
	});
});
