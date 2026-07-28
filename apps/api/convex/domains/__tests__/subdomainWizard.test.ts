/**
 * P4-7 — the per-stream subdomain wizard (plan gap G-14).
 *
 * Pins the proposed layout and the ONE-PASS generation of SPF + a per-subdomain
 * DKIM selector + DMARC for every stream subdomain, including the bounces/VERP
 * host.
 */

import { describe, expect, it } from 'vitest';
import {
	generateStreamSubdomainRecords,
	streamSubdomainRecordValue,
	type StreamSubdomainRecord,
	type StreamSubdomainRecordInput,
} from '../streamSubdomainRecords';
import {
	SUBDOMAIN_ADVICE_COPY,
	deriveSubdomainDkimSelectors,
	planStreamSubdomains,
	type SubdomainLayoutInput,
	type SubdomainLayoutProposal,
} from '../streamSubdomains';

const BASE = {
	domain: 'example.com',
	sendingIps: ['203.0.113.10', '203.0.113.11'],
	dmarcPolicy: 'none' as const,
	mailHost: 'mta.example.com',
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

	it('the bounce host sends nothing, so it has no selector and no pool', () => {
		const bounce = layout.subdomainsByRole.bounce;
		expect(bounce.sends).toBe(false);
		expect(bounce.dkimSelectorBase).toBeNull();
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

	it('derives a DISTINCT selector base per sending subdomain', () => {
		const selectors = deriveSubdomainDkimSelectors('s1711');
		expect(selectors.transactional).not.toBe(selectors.bulk);
		const bases = layout.subdomains.filter((s) => s.sends).map((s) => s.dkimSelectorBase);
		expect(new Set(bases).size).toBe(bases.length);
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
		const result = generateStreamSubdomainRecords({ domain: 'localhost', dmarcPolicy: 'none' });
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

	it('publishes ONE SPF record per subdomain, authorising the pool', () => {
		const spf = records.filter((r) => r.purpose === 'spf' && r.subdomain === 'news.example.com');
		expect(spf).toHaveLength(1);
		expect(spf[0] && streamSubdomainRecordValue(spf[0])).toBe(
			'v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 ~all'
		);
		expect(spf[0]?.host).toBe('news.example.com');
		expect(spf[0]?.relativeHost).toBe('news');
	});

	it('gives each subdomain its OWN DKIM selector under its OWN host', () => {
		const dkim = records.filter(isDkim);
		const hosts = dkim.map((r) => r.host);
		expect(hosts).toEqual([
			expect.stringContaining('._domainkey.mail.example.com'),
			expect.stringContaining('._domainkey.news.example.com'),
		]);
		expect(new Set(hosts).size).toBe(hosts.length);
	});

	it('a PENDING DKIM row carries no copyable value at all', () => {
		// An empty `p=` is not "blank": RFC 6376 §3.6.1 defines it as a REVOCATION.
		// On a copy-this-table surface that would revoke the selector the mail is
		// about to be signed with, so the pending row must structurally have no
		// value — not an empty one.
		const dkim = records.filter(isDkim);
		expect(dkim).not.toHaveLength(0);
		for (const row of dkim) {
			expect(row.key.status).toBe('pending');
			expect(streamSubdomainRecordValue(row)).toBeNull();
			expect(JSON.stringify(row)).not.toContain('p=');
		}
	});

	it('carries the DKIM public key through when the identity already exists', () => {
		const dkim = recordsOf({
			...BASE,
			dkimPublicKeys: { transactional: 'AAAA', bulk: 'BBBB' },
		}).filter(isDkim);
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
			dmarcPolicy: 'quarantine',
			dmarcRua: 'mailto:dmarc@example.com',
		});
		for (const row of strict.filter((r) => r.purpose === 'dmarc')) {
			expect(streamSubdomainRecordValue(row)).toBe(
				'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com'
			);
		}
	});

	it('NEVER publishes a stricter DMARC than the operator configured', () => {
		// `sp=`, `pct=`, `adkim=` and `aspf=` are shipped, persisted settings. A
		// one-pass generator that dropped them would take a domain deliberately
		// staged at 10 % to full enforcement on 100 % of the stream, and relax
		// alignment the operator chose to make strict.
		const staged = recordsOf({
			...BASE,
			dmarcPolicy: 'reject',
			dmarcSubdomainPolicy: 'none',
			dmarcPct: 10,
			dmarcAdkim: 's',
			dmarcAspf: 'r',
		});
		const dmarc = staged.filter((r) => r.purpose === 'dmarc');
		expect(dmarc).toHaveLength(2);
		for (const row of dmarc) {
			expect(streamSubdomainRecordValue(row)).toBe(
				'v=DMARC1; p=reject; sp=none; pct=10; adkim=s; aspf=r'
			);
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

	it('authorises a relay arm on the SAME record rather than a second one', () => {
		const withRelay = recordsOf({ ...BASE, relaySpfTerms: ['include:amazonses.com'] });
		const spf = withRelay.filter((r) => r.purpose === 'spf' && r.subdomain === 'news.example.com');
		expect(spf).toHaveLength(1);
		expect(spf[0] && streamSubdomainRecordValue(spf[0])).toBe(
			'v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 include:amazonses.com ~all'
		);
	});

	it('renders rather than throws on a malformed pool IP', () => {
		const degraded = recordsOf({ ...BASE, sendingIps: ['not-an-ip', '203.0.113.10'] });
		const spf = degraded.find((r) => r.purpose === 'spf' && r.subdomain === 'mail.example.com');
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
		}).find((r) => r.purpose === 'spf' && r.subdomain === 'news.example.com');
		const value = spf === undefined ? '' : (streamSubdomainRecordValue(spf) ?? '');
		expect(value.match(/ip6:/g)).toHaveLength(1);
	});
});
