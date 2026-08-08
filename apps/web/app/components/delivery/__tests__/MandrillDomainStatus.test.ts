// @vitest-environment happy-dom
/**
 * The Mandrill sending-domain panel: derived records, Mandrill's own error text,
 * the separate ownership step, and the stale-verified state that reads
 * "re-checking" rather than "verified".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';

const stubs = { Icon: { template: '<i />' } };

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface Identity {
	domain: string;
	status: 'unverified' | 'pending_dns' | 'verified' | 'failed';
	spf: { isValid: boolean; error?: string } | null;
	dkim: { isValid: boolean; error?: string } | null;
	isValidSigning: boolean;
	verifiedAt: number | null;
	lastError: string | null;
	lastCheckedAt: number;
	nextCheckDueAt: number | null;
	proofMaxAgeMs: number;
	records: {
		spf: { type: string; host: string; value: string } | null;
		dkim: { type: string; host: string; value: string }[];
		ownership: { type: string; host: string; value: string } | null;
	};
}

function identity(over: Partial<Identity> = {}): Identity {
	return {
		domain: 'example.com',
		status: 'verified',
		spf: { isValid: true },
		dkim: { isValid: true },
		isValidSigning: true,
		verifiedAt: Date.now() - 1000,
		lastError: null,
		lastCheckedAt: Date.now() - 1000,
		nextCheckDueAt: Date.now() + 60_000,
		proofMaxAgeMs: WEEK,
		records: {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 include:spf.mandrillapp.com -all' },
			dkim: [{ type: 'TXT', host: 'mandrill._domainkey', value: 'v=DKIM1; k=rsa; p=AAAA' }],
			ownership: null,
		},
		...over,
	};
}

/**
 * The component queries for itself (both host pages sit at the file-size cap),
 * so the read is stubbed the way the shipped delivery tests stub theirs.
 */
async function mountPanel(identities: Identity[]) {
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('useOrganizationQuery', () => ({ data: { value: identities } }));
	const component = (await import('../MandrillDomainStatus.vue')).default;
	return mount(component, { global: { stubs } });
}

// NOT `unstubAllGlobals`: the shared setup file installs Vue's reactivity
// primitives as globals, and clearing every stub would take those with it.
afterEach(() => {
	vi.resetModules();
});

describe('MandrillDomainStatus', () => {
	it('renders nothing when Mandrill was never connected', async () => {
		const wrapper = await mountPanel([]);
		expect(wrapper.find('[data-testid="mandrill-domain-status"]').exists()).toBe(false);
	});

	it('shows the derived SPF and DKIM records verbatim', async () => {
		const wrapper = await mountPanel([identity()]);
		const records = wrapper.findAll('[data-testid="mandrill-dns-record"]');
		expect(records).toHaveLength(2);
		expect(records[0]!.text()).toContain('v=spf1 include:spf.mandrillapp.com -all');
		expect(records[1]!.text()).toContain('mandrill._domainkey');
	});

	it('reads Verified for a fresh proof', async () => {
		const wrapper = await mountPanel([identity()]);
		expect(wrapper.find('[data-testid="mandrill-domain-state"]').text()).toBe('Verified');
	});

	it('reads Re-checking, not Verified, once the proof has aged out', async () => {
		const wrapper = await mountPanel([identity({ lastCheckedAt: Date.now() - WEEK - 60_000 })]);
		expect(wrapper.find('[data-testid="mandrill-domain-state"]').text()).toBe('Re-checking');
		expect(wrapper.text()).toContain('older than Owlat will rely on');
	});

	it('shows Mandrill’s own SPF and DKIM error text unedited', async () => {
		const wrapper = await mountPanel([
			identity({
				status: 'pending_dns',
				verifiedAt: null,
				spf: { isValid: false, error: 'no valid SPF record found' },
				dkim: { isValid: false, error: 'no TXT record at mandrill._domainkey' },
			}),
		]);
		expect(wrapper.find('[data-testid="mandrill-spf-error"]').text()).toContain(
			'no valid SPF record found'
		);
		expect(wrapper.find('[data-testid="mandrill-dkim-error"]').text()).toContain(
			'no TXT record at mandrill._domainkey'
		);
		expect(wrapper.text()).toContain('Outstanding: SPF · DKIM · domain ownership');
	});

	it('shows the mandrill_verify TXT record when this account has a token', async () => {
		const wrapper = await mountPanel([
			identity({
				status: 'pending_dns',
				verifiedAt: null,
				records: {
					...identity().records,
					ownership: { type: 'TXT', host: '@', value: 'mandrill_verify.abc123' },
				},
			}),
		]);
		expect(wrapper.find('[data-testid="mandrill-ownership"]').text()).toContain(
			'mandrill_verify.abc123'
		);
	});

	it('sends the operator to Mandrill’s dashboard when no token was issued', async () => {
		const wrapper = await mountPanel([identity({ status: 'pending_dns', verifiedAt: null })]);
		const ownership = wrapper.find('[data-testid="mandrill-ownership"]');
		expect(ownership.text()).toContain('Sending Domains');
		expect(ownership.text()).not.toContain('mandrill_verify');
	});

	it('hides the ownership step once ownership is proven', async () => {
		const wrapper = await mountPanel([identity()]);
		expect(wrapper.find('[data-testid="mandrill-ownership"]').exists()).toBe(false);
	});

	it('surfaces a rejected credential without touching the DNS verdicts', async () => {
		const wrapper = await mountPanel([
			identity({ status: 'failed', verifiedAt: null, lastError: 'Invalid API key' }),
		]);
		expect(wrapper.find('[data-testid="mandrill-last-error"]').text()).toContain('Invalid API key');
		expect(wrapper.find('[data-testid="mandrill-domain-state"]').text()).toBe('Cannot check');
		// The published records are still shown — a bad key is not evidence the DNS broke.
		expect(wrapper.findAll('[data-testid="mandrill-dns-record"]')).toHaveLength(2);
	});

	it('names when the identity was last confirmed and when it is asked again', async () => {
		const wrapper = await mountPanel([identity()]);
		const freshness = wrapper.find('[data-testid="mandrill-freshness"]').text();
		expect(freshness).toContain('Last confirmed');
		expect(freshness).toContain('next automatic check');
	});
});
