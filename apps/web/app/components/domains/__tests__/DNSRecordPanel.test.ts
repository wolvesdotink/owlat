import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

// `useCopyToClipboard` is a Nuxt auto-import; the SFC references it as a bare
// global, so stub it before the component module is evaluated.
beforeAll(() => {
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: vi.fn(),
		isCopied: () => false,
		copiedKey: ref(null),
		reset: vi.fn(),
	}));
});

import DNSRecordPanel from '../DNSRecordPanel.vue';

const baseRecord = { type: 'TXT', host: '@', value: 'v=spf1 include:_spf.owlat.test ~all' };

function mountPanel(verification?: Record<string, unknown>) {
	return mount(DNSRecordPanel, {
		props: {
			record: baseRecord,
			label: 'SPF',
			domain: 'example.com',
			verification,
		},
		// <Icon> is a Nuxt component; render it as an inert stub.
		global: { stubs: { Icon: true } },
	});
}

describe('DNSRecordPanel diagnostics', () => {
	it('shows no diagnostic when the record is verified', () => {
		const w = mountPanel({ verified: true, foundValue: baseRecord.value });
		expect(w.find('[data-testid="dns-diagnostic"]').exists()).toBe(false);
	});

	it('shows no diagnostic when there is no verification result', () => {
		const w = mountPanel(undefined);
		expect(w.find('[data-testid="dns-diagnostic"]').exists()).toBe(false);
	});

	it('renders the error and found value when not verified', () => {
		const w = mountPanel({
			verified: false,
			error: 'No matching TXT record found',
			foundValue: 'v=spf1 include:_spf.other.test -all',
		});
		expect(w.find('[data-testid="dns-diagnostic"]').exists()).toBe(true);
		expect(w.find('[data-testid="dns-diagnostic-error"]').text()).toBe('No matching TXT record found');
		expect(w.find('[data-testid="dns-diagnostic-found"]').text()).toContain(
			'v=spf1 include:_spf.other.test -all',
		);
	});

	it('renders the error alone when no found value is present', () => {
		const w = mountPanel({ verified: false, error: 'No DNS record found at this hostname' });
		expect(w.find('[data-testid="dns-diagnostic"]').exists()).toBe(true);
		expect(w.find('[data-testid="dns-diagnostic-error"]').text()).toBe(
			'No DNS record found at this hostname',
		);
		expect(w.find('[data-testid="dns-diagnostic-found"]').exists()).toBe(false);
	});

	it('shows no diagnostic when not verified but no error string is provided', () => {
		const w = mountPanel({ verified: false });
		expect(w.find('[data-testid="dns-diagnostic"]').exists()).toBe(false);
	});
});
