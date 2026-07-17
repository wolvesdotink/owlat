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

function mountPanel(verification?: Record<string, unknown>, record: Record<string, unknown> = baseRecord) {
	return mount(DNSRecordPanel, {
		props: {
			record,
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

describe('DNSRecordPanel MX priority (F2 finding 2)', () => {
	// Verification enforces the MX preference EXACTLY (verifyMxRecord), so the
	// panel must SHOW the priority — otherwise a user publishes the MX at a
	// different preference and fails verification forever with nothing on screen
	// to explain it. The displayed + copied value is the full `<priority> <host>`.
	const mxRecord = {
		type: 'MX',
		host: 'bounce.example.com',
		value: 'mail.example.com',
		hostIsFqdn: true,
		priority: 10,
	};

	it('shows the priority in the value field for an MX record', () => {
		const w = mountPanel(undefined, mxRecord);
		expect(w.find('[data-testid="dns-value"]').text()).toBe('10 mail.example.com');
	});

	it('copies the full `<priority> <exchange>` value', () => {
		const copy = vi.fn();
		vi.stubGlobal('useCopyToClipboard', () => ({
			copy,
			isCopied: () => false,
			copiedKey: ref(null),
			reset: vi.fn(),
		}));
		const w = mount(DNSRecordPanel, {
			props: { record: mxRecord, label: 'MAIL FROM', domain: 'example.com' },
			global: { stubs: { Icon: true } },
		});
		w.find('button[title="Copy value"]').trigger('click');
		expect(copy).toHaveBeenCalledWith('10 mail.example.com', 'MAIL FROM-value');
	});

	it('shows the value verbatim (no priority prefix) for non-MX records', () => {
		const w = mountPanel(undefined, baseRecord);
		expect(w.find('[data-testid="dns-value"]').text()).toBe(baseRecord.value);
	});
});
