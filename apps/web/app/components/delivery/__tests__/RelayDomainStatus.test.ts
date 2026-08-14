// @vitest-environment happy-dom
/**
 * ONE PANEL, EVERY RELAY — the component's own wiring.
 *
 * `utils/__tests__/relayDomainDisplay.test.ts` pins the wording; this pins what
 * the component does with a page of rows, and it is the file where the two
 * shipped panels' cases now live side by side:
 *
 *  - the SES cases came from this file's previous revision, where the gate was
 *    `ANSWERS_FOR_KINDS = ['ses']` plus a second `listRoutes` subscription. Both
 *    are gone: the query answers only where there is something true to say, so
 *    "are there rows?" is the whole gate and the deployment-shaped cases (no
 *    hatch configured, a hatch of another kind) are pinned in the BACKEND suite
 *    where the decision now lives;
 *  - the Mandrill cases came from `MandrillDomainStatus.test.ts`, whose
 *    component this one replaced — derived records, the provider's own error
 *    text, the separate ownership step and its console fallback;
 *  - the PLUGIN case is new, and is the one no arrangement of the two shipped
 *    panels could have covered: a kind whose name exists only at composition
 *    time, rendering with no per-vendor copy at all.
 *
 * The component queries for itself by design, so the read is stubbed the way the
 * shipped delivery suites stub theirs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const stubs = {
	Icon: { template: '<i />' },
	UiButton: { template: '<button><slot /></button>' },
};

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface Row {
	domainId: string;
	domain: string;
	kind: string;
	kindLabel: string;
	status: string;
	records: { label: string; type?: string; host?: string; value: string }[];
	spf?: { isValid: boolean; error?: string };
	dkim?: { isValid: boolean; error?: string };
	lastError?: string;
	lastCheckedAt?: number;
	nextCheckDueAt?: number;
	proofMaxAgeMs?: number;
	isOwnershipVerified?: boolean;
	spfProof?: string;
}

function sesRow(over: Partial<Row> = {}): Row {
	return {
		domainId: 'd1',
		domain: 'example.com',
		kind: 'ses',
		kindLabel: 'Amazon SES',
		status: 'pending',
		records: [{ label: 'SPF', type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com' }],
		...over,
	};
}

function mandrillRow(over: Partial<Row> = {}): Row {
	return {
		domainId: 'd2',
		domain: 'example.com',
		kind: 'mandrill',
		kindLabel: 'Mailchimp Transactional (Mandrill)',
		status: 'verified',
		records: [
			{ label: 'SPF', type: 'TXT', host: '@', value: 'v=spf1 include:spf.mandrillapp.com -all' },
			{ label: 'DKIM', type: 'TXT', host: 'mandrill._domainkey', value: 'v=DKIM1; k=rsa; p=AAAA' },
		],
		spf: { isValid: true },
		dkim: { isValid: true },
		lastCheckedAt: Date.now() - 1000,
		nextCheckDueAt: Date.now() + 60_000,
		proofMaxAgeMs: WEEK,
		isOwnershipVerified: true,
		...over,
	};
}

async function mountPanel(rows: Row[]) {
	vi.stubGlobal('computed', computed);
	// The panel's copy flows through vue-i18n now; `useI18n` is a Nuxt
	// auto-import, so it has to exist as a bare global for the setup.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	// REAL refs, not `{ value }` literals: the template renders the rows through a
	// computed, and Vue only unwraps something `isRef` says is a ref.
	vi.stubGlobal('usePaginatedQuery', () => ({
		results: ref(rows),
		status: ref('Exhausted'),
		loadMore: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	const component = (await import('../RelayDomainStatus.vue')).default;
	return mount(component, { global: { stubs, plugins: [createTestI18n()] } });
}

function isRendered(wrapper: { find: (selector: string) => { exists: () => boolean } }): boolean {
	return wrapper.find('[data-testid="relay-domain-status"]').exists();
}

// NOT `unstubAllGlobals`: the shared setup file installs Vue's reactivity
// primitives as globals, and clearing every stub would take those with it.
afterEach(() => {
	vi.resetModules();
});

describe('RelayDomainStatus', () => {
	it('renders nothing when the query answers for no relay at all', async () => {
		// The gate IS the rows now. A deployment with no relay configured and no
		// identity gets an empty page from the backend, so there is nothing left
		// for the browser to decide.
		expect(isRendered(await mountPanel([]))).toBe(false);
	});

	it('shows the DNS plan and the publish-before-enable instruction', async () => {
		const wrapper = await mountPanel([sesRow({ status: 'provisioning', records: [] })]);
		expect(isRendered(wrapper)).toBe(true);
		expect(wrapper.text()).toContain(
			'Publish these records before automatic fallback can activate'
		);
	});

	it('keeps published records on screen after the hatch is removed', async () => {
		const wrapper = await mountPanel([sesRow()]);
		expect(wrapper.text()).toContain('v=spf1 include:amazonses.com');
	});

	it('keeps SES’s apex-SPF exemption, worded from the row’s own label', async () => {
		const wrapper = await mountPanel([
			sesRow({ spfProof: 'not_applicable_manual_primary', records: [] }),
		]);
		const note = wrapper.find('[data-testid="relay-spf-not-applicable"]');
		expect(note.text()).toContain('Keep the reviewed manual primary SPF policy');
		expect(note.text()).toContain('Amazon SES');
	});

	it('names each relay from the catalog label the row carries', async () => {
		const wrapper = await mountPanel([sesRow(), mandrillRow()]);
		const providers = wrapper
			.findAll('[data-testid="relay-domain-provider"]')
			.map((node) => node.text());
		expect(providers).toEqual(['Amazon SES', 'Mailchimp Transactional (Mandrill)']);
	});

	it('shows one block per (domain, relay) when two relays answer for one domain', async () => {
		const wrapper = await mountPanel([sesRow(), mandrillRow()]);
		expect(wrapper.findAll('[data-testid="relay-domain-row"]')).toHaveLength(2);
	});

	it('renders Mandrill’s derived records and its own error text unedited', async () => {
		const wrapper = await mountPanel([
			mandrillRow({
				status: 'pending',
				isOwnershipVerified: false,
				spf: { isValid: false, error: 'no valid SPF record found' },
				dkim: { isValid: false, error: 'no TXT record at mandrill._domainkey' },
			}),
		]);
		const records = wrapper.findAll('[data-testid="relay-dns-record"]');
		expect(records).toHaveLength(2);
		expect(records[0]!.text()).toContain('v=spf1 include:spf.mandrillapp.com -all');
		expect(wrapper.find('[data-testid="relay-spf-error"]').text()).toContain(
			'no valid SPF record found'
		);
		expect(wrapper.find('[data-testid="relay-dkim-error"]').text()).toContain(
			'no TXT record at mandrill._domainkey'
		);
		expect(wrapper.text()).toContain('Outstanding: SPF · DKIM · domain ownership');
	});

	it('reads Re-checking, not Verified, once the proof has aged out', async () => {
		const wrapper = await mountPanel([mandrillRow({ lastCheckedAt: Date.now() - WEEK - 60_000 })]);
		expect(wrapper.find('[data-testid="relay-domain-state"]').text()).toBe('Re-checking');
		expect(wrapper.text()).toContain('older than Owlat will rely on');
	});

	it('shows the ownership TXT as its own step when the provider issued one', async () => {
		const wrapper = await mountPanel([
			mandrillRow({
				status: 'pending',
				isOwnershipVerified: false,
				records: [
					...mandrillRow().records,
					{ label: 'Ownership', type: 'TXT', host: '@', value: 'mandrill_verify.abc123' },
				],
			}),
		]);
		expect(wrapper.find('[data-testid="relay-ownership"]').text()).toContain(
			'mandrill_verify.abc123'
		);
		// And it is NOT folded into the record list: three records, two of them DNS.
		expect(wrapper.findAll('[data-testid="relay-dns-record"]')).toHaveLength(2);
	});

	it('sends the operator to Mandrill’s dashboard when no token was issued', async () => {
		const wrapper = await mountPanel([
			mandrillRow({ status: 'pending', isOwnershipVerified: false }),
		]);
		const ownership = wrapper.find('[data-testid="relay-ownership"]');
		expect(ownership.text()).toContain('Sending Domains');
		expect(ownership.text()).not.toContain('mandrill_verify');
	});

	it('hides the ownership step once ownership is proven', async () => {
		expect(
			(await mountPanel([mandrillRow()])).find('[data-testid="relay-ownership"]').exists()
		).toBe(false);
	});

	it('surfaces a rejected credential without touching the DNS verdicts', async () => {
		const wrapper = await mountPanel([
			mandrillRow({ status: 'failed', isOwnershipVerified: false, lastError: 'Invalid API key' }),
		]);
		expect(wrapper.find('[data-testid="relay-last-error"]').text()).toContain('Invalid API key');
		expect(wrapper.find('[data-testid="relay-domain-state"]').text()).toBe('Cannot check');
		// The published records are still shown — a bad key is not evidence the DNS broke.
		expect(wrapper.findAll('[data-testid="relay-dns-record"]')).toHaveLength(2);
	});

	it('names when the identity was last confirmed and when it is asked again', async () => {
		const wrapper = await mountPanel([mandrillRow()]);
		const freshness = wrapper.find('[data-testid="relay-freshness"]').text();
		expect(freshness).toContain('Last confirmed');
		expect(freshness).toContain('next automatic check');
	});

	it('renders a plugin relay with no vendor copy anywhere', async () => {
		// The case neither shipped panel could have covered: the kind is
		// `plugin.<id>.<local>`, decided at composition time, so no map in this
		// component could hold it and no query naming vendors could return it.
		const wrapper = await mountPanel([
			{
				domainId: 'd3',
				domain: 'example.com',
				kind: 'plugin.mail-pack.postmark',
				kindLabel: 'Postmark',
				status: 'pending',
				records: [
					{ label: 'SPF mechanism', value: 'include:spf.postmarkapp.example' },
					{ label: 'DKIM selector', value: 'pm-bounces' },
				],
				spf: { isValid: false, error: 'no matching include found' },
				dkim: { isValid: true },
				lastCheckedAt: Date.now() - 1000,
				proofMaxAgeMs: WEEK,
			},
		]);
		expect(isRendered(wrapper)).toBe(true);
		expect(wrapper.find('[data-testid="relay-domain-provider"]').text()).toBe('Postmark');
		expect(wrapper.find('[data-testid="relay-domain-state"]').text()).toBe('Waiting on DNS');
		expect(wrapper.text()).toContain('Postmark re-checks on its own schedule');
		expect(wrapper.text()).toContain('include:spf.postmarkapp.example');
		expect(wrapper.text()).toContain('no matching include found');
		expect(wrapper.text()).not.toContain('Mandrill');
		expect(wrapper.text()).not.toContain('SES');
		// No ownership step invented for a tier that reports no ownership verdict.
		expect(wrapper.find('[data-testid="relay-ownership"]').exists()).toBe(false);
	});
});
