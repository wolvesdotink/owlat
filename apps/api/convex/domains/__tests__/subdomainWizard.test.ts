/**
 * P4-7 — the per-stream subdomain wizard (plan gap G-14).
 *
 * Pins the proposed layout and the ONE-PASS generation of SPF + a per-subdomain
 * DKIM selector + DMARC for every stream subdomain, including the bounces/VERP
 * host — AND pins that the rows the wizard renders for a host are byte-identical
 * to the ones the shipped provider adapter generates for that same host. The
 * panel is mounted next to the shipped table, so "identical" is not a nicety:
 * two rows labelled SPF with different values for one name is a way to break a
 * verified domain.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';
import {
	generateStreamSubdomainRecords,
	streamSubdomainRecordValue,
	type StreamSubdomainRecord,
	type StreamSubdomainRecordInput,
} from '../streamSubdomainRecords';
import {
	SUBDOMAIN_ADVICE_COPY,
	planStreamSubdomains,
	type SubdomainLayoutInput,
	type SubdomainLayoutProposal,
} from '../streamSubdomains';

/**
 * Monitor-only on both signing hosts — the shipped default a freshly registered
 * name publishes. `_dmarc` is PER-FQDN, so the generator takes one setting per
 * signing role rather than one for the whole layout.
 */
const DMARC_NONE = {
	transactional: { policy: 'none' },
	bulk: { policy: 'none' },
} as const;

const MINTED_SELECTOR = 'owlat-1711';
const MINTED_DKIM_VALUE = 'v=DKIM1; k=rsa; p=MIIBIjAN-fixture';

const mockRole: OrganizationRole = 'admin';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole, activeOrganizationId: 'org-a' });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ctx()),
		requireOrgPermission: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

vi.mock('../../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => ({
		registerDomain: () =>
			Promise.resolve({ selector: MINTED_SELECTOR, dnsRecord: MINTED_DKIM_VALUE }),
		deleteDomain: () => Promise.resolve(),
	}),
}));

const BASE = {
	domain: 'example.com',
	sendingIps: ['203.0.113.10', '203.0.113.11'],
	dmarcByRole: DMARC_NONE,
	mailHost: 'mta.example.com',
	spfInclude: 'spf.owlat.example',
};

function layoutOf(input: SubdomainLayoutInput): SubdomainLayoutProposal {
	const result = planStreamSubdomains(input);
	if (!result.ok) throw new Error(`expected a layout for ${input.domain}`);
	return result.proposal;
}

function recordsOf(input: StreamSubdomainRecordInput): StreamSubdomainRecord[] {
	const result = generateStreamSubdomainRecords(input);
	if (!result.ok) throw new Error(`expected records for ${input.domain}`);
	return result.recordSet.records;
}

type DkimRow = Extract<StreamSubdomainRecord, { purpose: 'dkim' }>;
const isDkim = (record: StreamSubdomainRecord): record is DkimRow => record.purpose === 'dkim';

describe('the proposed layout', () => {
	const layout = layoutOf({ domain: 'example.com' });

	it('proposes the plan table by default: mail. / news. / bounces.', () => {
		expect(layout.subdomains.map((s) => s.host)).toEqual([
			'mail.example.com',
			'news.example.com',
			'bounces.example.com',
		]);
	});

	it('routes transactional to mail. and both bulk streams to news.', () => {
		expect(layout.streamHosts).toEqual({
			transactional: 'mail.example.com',
			campaign: 'news.example.com',
			automation: 'news.example.com',
		});
	});

	it('keeps transactional in its own pool so a campaign cannot delay a reset', () => {
		expect(layout.subdomainsByRole.transactional.pool).toBe('transactional');
		expect(layout.subdomainsByRole.bulk.pool).toBe('campaign');
	});

	it('the bounce host sends nothing, so it has no pool', () => {
		const bounce = layout.subdomainsByRole.bounce;
		expect(bounce.sends).toBe(false);
		expect(bounce.pool).toBeNull();
		expect(layout.bounceHost).toBe('bounces.example.com');
	});

	it('indexes the plans by role so no caller has to scan or invent a fallback', () => {
		for (const plan of layout.subdomains) {
			expect(layout.subdomainsByRole[plan.role]).toBe(plan);
		}
	});

	it('says the reputation-inheritance part IN THE WIZARD, not in the docs', () => {
		expect(layout.advice).toContain('no_reputation_inheritance');
		expect(layout.advice).toContain('each_subdomain_warms_separately');
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/does not inherit/i);
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/own SPF/i);
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/DKIM selector/i);
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/warm-?up/i);
	});

	it('carries no DKIM selector of its own — selectors are minted, not derived', () => {
		// A selector this module invented would be a name nothing in the system
		// signs with and nothing publishes. The layout must not offer one.
		expect(JSON.stringify(layout)).not.toContain('Selector');
	});

	it('splits a multi-label public suffix at the registrable zone', () => {
		const uk = layoutOf({ domain: 'shop.example.co.uk' });
		expect(uk.root).toBe('example.co.uk');
		expect(uk.bounceHost).toBe('bounces.example.co.uk');
		expect(uk.subdomains[0]?.relativeHost).toBe('mail');
	});
});

describe('a domain with no registrable zone degrades instead of throwing', () => {
	// The wizard is the screen an operator uses to FIX a bad name. Blowing it up
	// with an exception is the one response that makes that impossible.
	it.each(['localhost', 'internal', '', 'not a domain'])(
		'planStreamSubdomains reports invalid_domain for %j',
		(domain) => {
			const result = planStreamSubdomains({ domain });
			expect(result).toEqual({ ok: false, reason: 'invalid_domain' });
		}
	);

	it('generateStreamSubdomainRecords inherits the same degraded branch', () => {
		const result = generateStreamSubdomainRecords({ domain: 'localhost', dmarcByRole: DMARC_NONE });
		expect(result).toEqual({ ok: false, reason: 'invalid_domain' });
	});

	it('the happy branch still reports ok with a record set', () => {
		const result = generateStreamSubdomainRecords(BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.recordSet.records.length).toBeGreaterThan(0);
	});
});

describe('one-pass record generation', () => {
	const records = recordsOf(BASE);

	const forHost = (host: string) => records.filter((r) => r.subdomain === host);

	it('emits SPF + DKIM + DMARC for EVERY sending subdomain in one pass', () => {
		for (const host of ['mail.example.com', 'news.example.com']) {
			const purposes = forHost(host).map((r) => r.purpose);
			expect(purposes).toContain('spf');
			expect(purposes).toContain('dkim');
			expect(purposes).toContain('dmarc');
		}
	});

	it('publishes ONE SPF record per subdomain, from the deployment include', () => {
		const spf = records.filter((r) => r.purpose === 'spf' && r.subdomain === 'news.example.com');
		expect(spf).toHaveLength(1);
		expect(spf[0] && streamSubdomainRecordValue(spf[0])).toBe(
			'v=spf1 include:spf.owlat.example ~all'
		);
		expect(spf[0]?.host).toBe('news.example.com');
		expect(spf[0]?.relativeHost).toBe('news');
	});

	it('never enumerates the pool IPs on a From domain — they authorise the bounce host', () => {
		for (const row of records.filter((r) => r.subdomain !== 'bounces.example.com')) {
			expect(streamSubdomainRecordValue(row) ?? '').not.toContain('203.0.113.10');
		}
	});

	it('omits the From-domain SPF entirely when no include is configured', () => {
		// The shipped adapter omits it and logs; a wizard that invented a record in
		// its place would replace the operator's SPF with a different one.
		const withoutInclude = recordsOf({ ...BASE, spfInclude: undefined });
		expect(
			withoutInclude.filter((r) => r.purpose === 'spf' && r.subdomain !== 'bounces.example.com')
		).toHaveLength(0);
	});

	it('gives each subdomain its OWN DKIM row under its OWN host', () => {
		const dkim = records.filter(isDkim);
		const hosts = dkim.map((r) => r.host);
		expect(hosts).toEqual(['_domainkey.mail.example.com', '_domainkey.news.example.com']);
		expect(new Set(hosts).size).toBe(hosts.length);
	});

	it('a PENDING DKIM row carries no copyable value and no invented selector', () => {
		// An empty `p=` is not "blank": RFC 6376 §3.6.1 defines it as a REVOCATION.
		// On a copy-this-table surface that would revoke the selector the mail is
		// about to be signed with, so the pending row must structurally have no
		// value — not an empty one — and no selector label either.
		const dkim = records.filter(isDkim);
		expect(dkim).not.toHaveLength(0);
		for (const row of dkim) {
			expect(row.key.status).toBe('pending');
			expect(streamSubdomainRecordValue(row)).toBeNull();
			expect(JSON.stringify(row)).not.toContain('p=');
			expect(JSON.stringify(row)).not.toContain('selector');
		}
	});

	it('carries the MINTED selector and its published value once the name exists', () => {
		const dkim = recordsOf({
			...BASE,
			signingIdentities: {
				transactional: { selector: 'owlat-a', recordValue: 'v=DKIM1; k=rsa; p=AAAA' },
				bulk: { selector: 'owlat-b', recordValue: 'v=DKIM1; k=rsa; p=BBBB' },
			},
		}).filter(isDkim);
		expect(dkim.map((r) => r.host)).toEqual([
			'owlat-a._domainkey.mail.example.com',
			'owlat-b._domainkey.news.example.com',
		]);
		expect(dkim.map((r) => streamSubdomainRecordValue(r))).toEqual([
			'v=DKIM1; k=rsa; p=AAAA',
			'v=DKIM1; k=rsa; p=BBBB',
		]);
		expect(dkim.every((r) => r.key.status === 'published')).toBe(true);
	});

	it('publishes _dmarc under each sending subdomain, not only at the root', () => {
		const dmarc = records.filter((r) => r.purpose === 'dmarc');
		expect(dmarc.map((r) => r.host)).toEqual([
			'_dmarc.mail.example.com',
			'_dmarc.news.example.com',
		]);
		expect(dmarc[0] && streamSubdomainRecordValue(dmarc[0])).toBe('v=DMARC1; p=none');
		expect(dmarc[0]?.relativeHost).toBe('_dmarc.mail');
	});

	it('threads the policy and the rua mailbox into every DMARC row', () => {
		const strict = recordsOf({
			...BASE,
			dmarcByRole: { transactional: { policy: 'quarantine' }, bulk: { policy: 'quarantine' } },
			dmarcRua: 'mailto:dmarc@example.com',
		});
		for (const row of strict.filter((r) => r.purpose === 'dmarc')) {
			expect(streamSubdomainRecordValue(row)).toBe(
				'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com'
			);
		}
	});

	const STAGED_DMARC = {
		policy: 'reject',
		subdomainPolicy: 'none',
		pct: 10,
	} as const;

	it('NEVER publishes a stricter DMARC than the operator configured', () => {
		// `sp=` and `pct=` are the knobs the schema persists next to `p=`
		// (`dmarcSubdomainPolicy`, `dmarcPct`). A one-pass generator that dropped
		// them would take a domain deliberately staged at 10 % to full enforcement
		// on 100 % of the stream.
		const staged = recordsOf({
			...BASE,
			dmarcByRole: {
				transactional: STAGED_DMARC,
				bulk: STAGED_DMARC,
			},
		});
		const dmarc = staged.filter((r) => r.purpose === 'dmarc');
		expect(dmarc).toHaveLength(2);
		for (const row of dmarc) {
			expect(streamSubdomainRecordValue(row)).toBe('v=DMARC1; p=reject; sp=none; pct=10');
		}
	});

	it('includes the bounces/VERP host: its own SPF plus the DSN MX', () => {
		const bounce = forHost('bounces.example.com');
		expect(bounce.map((r) => r.purpose).sort()).toEqual(['mx', 'spf']);
		const mx = bounce.find((r) => r.purpose === 'mx');
		expect(mx?.type).toBe('MX');
		expect(mx && streamSubdomainRecordValue(mx)).toBe('mta.example.com');
		expect(mx?.purpose === 'mx' && mx.priority).toBe(10);
		const spf = bounce.find((r) => r.purpose === 'spf');
		expect(spf && streamSubdomainRecordValue(spf)).toContain('ip4:203.0.113.10');
	});

	it('keeps the relay authorisation on the bounce host, never on a From domain', () => {
		// MTA_RETURN_PATH_RELAY_SPF authorises the relay to stamp the bounce
		// envelope. Leaking it onto a From domain publishes an authorisation the
		// shipped generator never grants there.
		const withRelay = recordsOf({ ...BASE, returnPathRelaySpfTerms: ['include:amazonses.com'] });
		const bounceSpf = withRelay.find(
			(r) => r.purpose === 'spf' && r.subdomain === 'bounces.example.com'
		);
		expect(bounceSpf && streamSubdomainRecordValue(bounceSpf)).toContain('include:amazonses.com');
		for (const row of withRelay.filter((r) => r.subdomain !== 'bounces.example.com')) {
			expect(streamSubdomainRecordValue(row) ?? '').not.toContain('amazonses.com');
		}
	});

	it('renders rather than throws on a malformed pool IP', () => {
		const degraded = recordsOf({ ...BASE, sendingIps: ['not-an-ip', '203.0.113.10'] });
		const spf = degraded.find((r) => r.purpose === 'spf' && r.subdomain === 'bounces.example.com');
		expect(spf && streamSubdomainRecordValue(spf)).toBe('v=spf1 ip4:203.0.113.10 ~all');
	});

	it('normalises and de-dupes pool addresses ONCE for both readers', () => {
		// The same list must not read as two pools in the layout and as one
		// duplicated term in SPF: `2001:DB8::1` and `2001:db8::1` are one address,
		// and so are `203.0.113.010`-style forms once parsed.
		const layout = layoutOf({ domain: 'example.com', sendingIps: ['2001:DB8::1', '2001:db8::1'] });
		expect(layout.poolsCollapsed).toBe(true);

		const spf = recordsOf({
			...BASE,
			sendingIps: ['2001:DB8::1', '2001:db8::1'],
		}).find((r) => r.purpose === 'spf' && r.subdomain === 'bounces.example.com');
		const value = spf === undefined ? '' : (streamSubdomainRecordValue(spf) ?? '');
		expect(value.match(/ip6:/g)).toHaveLength(1);
	});
});

describe('shipped-generator parity for a host both tables cover', () => {
	// The panel is mounted inside the SAME expanded record row as the shipped
	// SPF/DKIM panels, and `mail.`/`news.` are exactly the names the Add-Domain
	// form suggests — so the collision is the common case, not an edge. These
	// fixtures pin the two generators to one value each.
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function shippedRecordsFor(host: string) {
		const { mtaProvider } = await import('../providers/mta/index');
		return mtaProvider.registerDomain(host);
	}

	it('emits the SAME SPF value the shipped adapter emits for that host', async () => {
		vi.stubEnv('MTA_SPF_INCLUDE', 'spf.owlat.example');
		vi.stubEnv('MTA_IP_POOLS', '');
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', '');
		const shipped = await shippedRecordsFor('news.example.com');
		const wizard = recordsOf(BASE).find(
			(r) => r.purpose === 'spf' && r.subdomain === 'news.example.com'
		);
		expect(shipped.dnsRecords.spf?.value).toBeDefined();
		expect(wizard && streamSubdomainRecordValue(wizard)).toBe(shipped.dnsRecords.spf?.value);
	});

	it('omits SPF in BOTH tables when the deployment has no include', async () => {
		vi.stubEnv('MTA_SPF_INCLUDE', '');
		vi.stubEnv('MTA_IP_POOLS', '');
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', '');
		const shipped = await shippedRecordsFor('news.example.com');
		expect(shipped.dnsRecords.spf).toBeUndefined();
		const wizard = recordsOf({ ...BASE, spfInclude: '' }).filter(
			(r) => r.purpose === 'spf' && r.subdomain === 'news.example.com'
		);
		expect(wizard).toHaveLength(0);
	});

	it('emits the SAME DKIM host and value the shipped adapter emits', async () => {
		vi.stubEnv('MTA_SPF_INCLUDE', 'spf.owlat.example');
		vi.stubEnv('MTA_IP_POOLS', '');
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', '');
		const shipped = await shippedRecordsFor('news.example.com');
		const shippedDkim = shipped.dnsRecords.dkim?.[0];
		expect(shippedDkim).toBeDefined();
		if (shippedDkim === undefined) return;

		const wizard = recordsOf({
			...BASE,
			signingIdentities: {
				bulk: {
					selector: shipped.identity.dkimSelector,
					recordValue: shippedDkim.value,
				},
			},
		}).find((r): r is DkimRow => isDkim(r) && r.subdomain === 'news.example.com');

		// The shipped row's host is relative to its own domain; the wizard's is
		// absolute because the table spans three names.
		expect(wizard?.host).toBe(`${shippedDkim.host}.news.example.com`);
		expect(wizard && streamSubdomainRecordValue(wizard)).toBe(shippedDkim.value);
	});
});

// ============ THE WIRING: every host publishes ITS OWN DMARC ============

/**
 * `_dmarc` is a PER-FQDN record, and each proposed name is an ordinary sending
 * domain with its own persisted policy. A wizard that stamped the VIEWED
 * domain's knobs onto every row would tell the operator to publish, on a
 * different and separately staged name, a record contradicting that name's own
 * DMARC panel — and if they copied it as instructed, move it to an enforcement
 * it never chose. Same for the BIMI offer, whose whole rule is about the policy
 * of the From domain the record is published ON.
 */
describe('the wizard reads each proposed host DMARC from that host', () => {
	async function seedTwoHosts(): Promise<{
		t: ReturnType<typeof convexTest>;
		mailId: Id<'domains'>;
	}> {
		const t = convexTest(schema, modules);
		const mailId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'verified',
				providerType: 'mta',
				dnsRecords: {},
				// Enforcing, with the apex's subdomains deliberately held back.
				dmarcPolicy: 'reject',
				dmarcSubdomainPolicy: 'none',
				createdAt: now,
				updatedAt: now,
			});
			// A SEPARATELY registered name, deliberately staged in monitor-only.
			await ctx.db.insert('domains', {
				domain: 'news.example.com',
				status: 'verified',
				providerType: 'mta',
				dnsRecords: {},
				dmarcPolicy: 'none',
				createdAt: now,
				updatedAt: now,
			});
			return id;
		});
		return { t, mailId };
	}

	it('never stamps the viewed policy onto another registered subdomain', async () => {
		const { t, mailId } = await seedTwoHosts();
		const plan = await t.query(api.domains.streamSubdomainWizard.getStreamSubdomainPlan, {
			domainId: mailId,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const dmarcFor = (host: string) =>
			plan.records.find((r) => r.purpose === 'dmarc' && r.host === `_dmarc.${host}`)?.value;
		expect(dmarcFor('mail.example.com')).toBe('v=DMARC1; p=reject; sp=none');
		// The staged host keeps ITS policy — this is the regression the row-drop
		// mitigation could never cover, because it only drops the viewed domain.
		expect(dmarcFor('news.example.com')).toBe('v=DMARC1; p=none');
	});

	it('offers BIMI on the host whose OWN policy enforces, and only there', async () => {
		const { t, mailId } = await seedTwoHosts();
		const plan = await t.query(api.domains.streamSubdomainWizard.getStreamSubdomainPlan, {
			domainId: mailId,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const offered = new Map(plan.bimiOffers.map((entry) => [entry.host, entry.offer.offered]));
		expect(offered.get('mail.example.com')).toBe(true);
		// `news.` is at p=none. Offering it a logo because ANOTHER host enforces is
		// exactly the inversion the card's rule forbids.
		expect(offered.get('news.example.com')).toBe(false);
	});

	it('falls back to the monitor-only default for a host not added yet', async () => {
		const t = convexTest(schema, modules);
		const mailId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'verified',
				providerType: 'mta',
				dnsRecords: {},
				dmarcPolicy: 'reject',
				createdAt: now,
				updatedAt: now,
			});
		});
		const plan = await t.query(api.domains.streamSubdomainWizard.getStreamSubdomainPlan, {
			domainId: mailId,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		// `news.example.com` does not exist yet, so the row shows what REGISTERING
		// it will actually publish — not the enforcement of the name next to it.
		const news = plan.records.find(
			(r) => r.purpose === 'dmarc' && r.host === '_dmarc.news.example.com'
		);
		expect(news?.value).toBe('v=DMARC1; p=none');
		const newsOffer = plan.bimiOffers.find((entry) => entry.host === 'news.example.com');
		expect(newsOffer?.offer.offered).toBe(false);
		expect(newsOffer?.offer.required).toBe(false);
	});
});
