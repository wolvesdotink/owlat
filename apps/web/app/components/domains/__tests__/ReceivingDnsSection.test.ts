// @vitest-environment happy-dom
/**
 * ReceivingDnsSection — the inbound (MX) guidance panel on the Sending Domains
 * page. Verifies the section renders the MX record guidance in BOTH the
 * inbound-enabled and not-yet-enabled states, so an admin setting up receiving
 * can always find the instructions (no chicken-and-egg where the guidance is
 * hidden behind the very flag they're trying to turn on).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

// `useBackendOperation` is a Nuxt auto-import the SFC references as a bare
// global; stub it before the component module is evaluated so the reverse-DNS
// preflight is inert in the test.
beforeAll(() => {
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(async () => undefined),
		isLoading: ref(false),
	}));
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

	it('renders nothing when there is no mail host to point at', () => {
		const w = mount(ReceivingDnsSection, {
			props: { domain: 'example.com', mailHost: null, inboundPort: 25, inboundEnabled: true },
			global: { stubs },
		});
		expect(w.find('[data-testid="dns-record"]').exists()).toBe(false);
	});
});
