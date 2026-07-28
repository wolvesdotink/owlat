// @vitest-environment happy-dom
/**
 * The per-stream subdomain wizard panel (P4-7, gap G-14) — real mounts.
 *
 * Every decision this panel renders is DERIVED by the backend's pure core, so
 * these fixtures feed it wire payloads and assert what an operator can see:
 * that an ineligible BIMI offer renders NOTHING (never a nag, D2), that a row
 * with no key yet offers nothing copyable, that the advice comes from the
 * backend's copy rather than from the component, and that a member who cannot
 * manage domains does not even subscribe.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';

beforeAll(() => {
	vi.stubGlobal('useCopyToClipboard', () => ({
		copy: vi.fn(),
		isCopied: () => false,
		copiedKey: ref(null),
		reset: vi.fn(),
	}));
});

// Static imports are hoisted above `beforeAll`, which is fine: the SFCs only
// call the auto-imported composables at setup() time, i.e. during mount.
import DNSRecordPanel from '../DNSRecordPanel.vue';
import StreamSubdomainPlanPanel from '../StreamSubdomainPlanPanel.vue';

const OFFER_WITHHELD = {
	offered: false,
	ineligibleReason: 'dmarc_policy_below_quarantine',
	record: null,
	rejectedInputs: [],
	vmcNote: null,
	vmcRequiredReceivers: ['gmail', 'apple'],
	required: false,
	nag: false,
};

const OFFER_MADE = {
	...OFFER_WITHHELD,
	offered: true,
	ineligibleReason: null,
	vmcNote: 'Gmail and Apple Mail require a Verified Mark Certificate (VMC).',
};

function planFixture(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		domain: 'example.com',
		subdomains: [
			{
				role: 'transactional',
				host: 'mail.example.com',
				relativeHost: 'mail',
				streams: ['transactional'],
				pool: 'transactional',
				sends: true,
				alreadyRegistered: true,
			},
			{
				role: 'bulk',
				host: 'news.example.com',
				relativeHost: 'news',
				streams: ['campaign', 'automation'],
				pool: 'campaign',
				sends: true,
				alreadyRegistered: false,
			},
		],
		poolsCollapsed: true,
		advice: [
			{ key: 'no_reputation_inheritance', text: 'A subdomain does not inherit anything.' },
			{ key: 'pools_collapsed_single_ip', text: 'One sending IP here.' },
		],
		records: [
			{
				subdomain: 'news.example.com',
				host: '_domainkey.news.example.com',
				relativeHost: '_domainkey.news',
				purpose: 'dkim',
				type: 'TXT',
				value: null,
				arm: 'own',
			},
			{
				subdomain: 'mail.example.com',
				host: 'owlat-1711._domainkey.mail.example.com',
				relativeHost: 'owlat-1711._domainkey.mail',
				purpose: 'dkim',
				type: 'TXT',
				value: 'v=DKIM1; k=rsa; p=AAAA',
				arm: 'own',
			},
		],
		warmingPlans: [
			{
				host: 'mail.example.com',
				role: 'transactional',
				pool: 'transactional',
				inheritsFromRoot: false,
				startDay: 1,
				streams: ['transactional'],
			},
		],
		bimiOffers: [{ host: 'mail.example.com', offer: OFFER_WITHHELD }],
		...overrides,
	};
}

let queryArgs: unknown;

function mountPanel(plan: unknown, canManage = true) {
	queryArgs = undefined;
	const data = ref(plan);
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: unknown) => {
		queryArgs = typeof args === 'function' ? (args as () => unknown)() : args;
		return { data, isLoading: ref(false) };
	});
	return mount(StreamSubdomainPlanPanel, {
		props: { domainId: 'domain_1', canManage },
		global: {
			stubs: { Icon: { props: ['name'], template: '<i :data-icon="name" />' } },
			components: { DomainsDNSRecordPanel: DNSRecordPanel },
		},
	});
}

describe('BIMI is an offer, never a nag', () => {
	it('renders NO BIMI node at all when the offer is withheld', () => {
		const w = mountPanel(planFixture());
		expect(w.find('[data-testid="stream-subdomain-bimi"]').exists()).toBe(false);
		expect(w.text()).not.toContain('BIMI');
	});

	it('renders the VMC note and the generated record once one is offered', () => {
		const w = mountPanel(
			planFixture({
				bimiOffers: [
					{
						host: 'mail.example.com',
						offer: {
							...OFFER_MADE,
							record: {
								type: 'TXT',
								host: 'default._bimi.mail.example.com',
								relativeHost: 'default._bimi.mail',
								value: 'v=BIMI1; l=https://example.com/logo.svg;',
							},
						},
					},
				],
			})
		);
		expect(w.find('[data-testid="stream-subdomain-bimi"]').exists()).toBe(true);
		expect(w.text()).toContain('Verified Mark Certificate');
		expect(w.text()).toContain('v=BIMI1; l=https://example.com/logo.svg;');
	});

	it('names the value to fix when a supplied URL could not be published', () => {
		const w = mountPanel(
			planFixture({
				bimiOffers: [
					{ host: 'mail.example.com', offer: { ...OFFER_MADE, rejectedInputs: ['logoUrl'] } },
				],
			})
		);
		const rejected = w.find('[data-testid="stream-subdomain-bimi-rejected"]');
		expect(rejected.exists()).toBe(true);
		expect(rejected.text()).toContain('MTA_BIMI_LOGO_URL');
	});
});

describe('a row with no key yet offers nothing copyable', () => {
	it('renders the pending state and never an empty p=', () => {
		const w = mountPanel(planFixture());
		expect(w.find('[data-testid="dns-value-pending"]').exists()).toBe(true);
		// The published row still renders its value, so the pending state is a
		// property of the ROW rather than of the panel.
		expect(w.text()).toContain('v=DKIM1; k=rsa; p=AAAA');
	});

	it('does not re-derive the DNS value — it renders exactly what the wire carries', () => {
		const w = mountPanel(
			planFixture({
				records: [
					{
						subdomain: 'news.example.com',
						host: 'sel._domainkey.news.example.com',
						relativeHost: 'sel._domainkey.news',
						purpose: 'dkim',
						type: 'TXT',
						value: 'BACKEND-SUPPLIED',
						arm: 'own',
					},
				],
			})
		);
		expect(w.text()).toContain('BACKEND-SUPPLIED');
	});
});

describe('a pending row explains itself in the terms of THAT row', () => {
	it('tells the operator to create the name for a key WE mint', () => {
		const w = mountPanel(planFixture());
		expect(w.find('[data-testid="dns-value-pending"]').text()).toContain('create the name first');
	});

	it('never tells the operator that adding the name yields the RELAY key', () => {
		// The ESP holds that key, so "create the name first, then come back and
		// copy the key" is an instruction that can never resolve — the row is
		// permanently pending until the operator pastes the relay's value.
		const w = mountPanel(
			planFixture({
				records: [
					{
						subdomain: 'news.example.com',
						host: '_domainkey.news.example.com',
						relativeHost: '_domainkey.news',
						purpose: 'dkim',
						type: 'TXT',
						value: null,
						arm: 'reference',
					},
				],
			})
		);
		const pending = w.find('[data-testid="dns-value-pending"]');
		expect(pending.text()).toContain('relay');
		expect(pending.text()).not.toContain('create the name first');
	});
});

describe('the panel does not duplicate the shipped table for this domain', () => {
	it('drops rows whose subdomain IS the domain being viewed', () => {
		// The shipped SPF/DKIM/DMARC panels for that host are directly above.
		const w = mountPanel(planFixture({ domain: 'mail.example.com' }));
		expect(w.text()).not.toContain('v=DKIM1; k=rsa; p=AAAA');
		// Rows for the OTHER proposed names are still shown.
		expect(w.find('[data-testid="dns-value-pending"]').exists()).toBe(true);
	});
});

describe('the proposal and its advice', () => {
	it('renders the advice lines from the backend copy, keyed', () => {
		const w = mountPanel(planFixture());
		const lines = w.findAll('[data-advice-key]');
		expect(lines).toHaveLength(2);
		expect(lines[0]?.attributes('data-advice-key')).toBe('no_reputation_inheritance');
		expect(lines[0]?.text()).toContain('does not inherit anything');
	});

	it('shows a name that already exists as DONE rather than as work', () => {
		const w = mountPanel(planFixture());
		const done = w.findAll('[data-testid="stream-subdomain-registered"]');
		expect(done).toHaveLength(1);
	});
});

describe('a member who cannot manage domains', () => {
	it('subscribes with skip so the admin-gated read is never issued', () => {
		const w = mountPanel(null, false);
		expect(queryArgs).toBe('skip');
		expect(w.find('[data-testid="stream-subdomain-plan"]').exists()).toBe(false);
	});
});
