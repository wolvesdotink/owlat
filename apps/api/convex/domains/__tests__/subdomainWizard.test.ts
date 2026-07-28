/**
 * P4-7 — the per-stream subdomain wizard (plan gap G-14).
 *
 * Pins the proposed layout and the ONE-PASS generation of SPF + a per-subdomain
 * DKIM selector + DMARC for every stream subdomain, including the bounces/VERP
 * host.
 */

import { describe, expect, it } from 'vitest';
import { generateStreamSubdomainRecords } from '../streamSubdomainRecords';
import {
	SUBDOMAIN_ADVICE_COPY,
	deriveSubdomainDkimSelectors,
	planStreamSubdomains,
} from '../streamSubdomains';

const BASE = {
	domain: 'example.com',
	sendingIps: ['203.0.113.10', '203.0.113.11'],
	dmarcPolicy: 'none' as const,
	mailHost: 'mta.example.com',
};

describe('the proposed layout', () => {
	const layout = planStreamSubdomains({ domain: 'example.com' });

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
		expect(layout.subdomains.find((s) => s.role === 'transactional')?.pool).toBe('transactional');
		expect(layout.subdomains.find((s) => s.role === 'bulk')?.pool).toBe('campaign');
	});

	it('the bounce host sends nothing, so it has no selector and no pool', () => {
		const bounce = layout.subdomains.find((s) => s.role === 'bounce');
		expect(bounce?.sends).toBe(false);
		expect(bounce?.dkimSelector).toBeNull();
		expect(bounce?.pool).toBeNull();
		expect(layout.bounceHost).toBe('bounces.example.com');
	});

	it('says the reputation-inheritance part IN THE WIZARD, not in the docs', () => {
		expect(layout.advice).toContain('no_reputation_inheritance');
		expect(layout.advice).toContain('each_subdomain_warms_separately');
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/does not inherit/i);
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/own SPF/i);
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/DKIM selector/i);
		expect(SUBDOMAIN_ADVICE_COPY.no_reputation_inheritance).toMatch(/warm-?up/i);
	});

	it('derives a DISTINCT selector per sending subdomain', () => {
		const selectors = deriveSubdomainDkimSelectors('s1711');
		expect(selectors.transactional).not.toBe(selectors.bulk);
		const hosts = layout.subdomains.filter((s) => s.sends).map((s) => s.dkimSelector);
		expect(new Set(hosts).size).toBe(hosts.length);
	});

	it('splits a multi-label public suffix at the registrable zone', () => {
		const uk = planStreamSubdomains({ domain: 'shop.example.co.uk' });
		expect(uk.root).toBe('example.co.uk');
		expect(uk.bounceHost).toBe('bounces.example.co.uk');
		expect(uk.subdomains[0]?.relativeHost).toBe('mail');
	});
});

describe('one-pass record generation', () => {
	const { records } = generateStreamSubdomainRecords(BASE);

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
		expect(spf[0]?.value).toBe('v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 ~all');
		expect(spf[0]?.host).toBe('news.example.com');
		expect(spf[0]?.relativeHost).toBe('news');
	});

	it('gives each subdomain its OWN DKIM selector under its OWN host', () => {
		const dkim = records.filter((r) => r.purpose === 'dkim');
		const hosts = dkim.map((r) => r.host);
		expect(hosts).toEqual([
			expect.stringContaining('._domainkey.mail.example.com'),
			expect.stringContaining('._domainkey.news.example.com'),
		]);
		expect(new Set(hosts).size).toBe(hosts.length);
		// No key yet ⇒ the row is shown but flagged, never a copyable empty value.
		expect(dkim.every((r) => r.pendingKey === true)).toBe(true);
	});

	it('carries the DKIM public key through when the identity already exists', () => {
		const { records: withKeys } = generateStreamSubdomainRecords({
			...BASE,
			dkimPublicKeys: { transactional: 'AAAA', bulk: 'BBBB' },
		});
		const dkim = withKeys.filter((r) => r.purpose === 'dkim');
		expect(dkim.map((r) => r.value)).toEqual(['v=DKIM1; k=rsa; p=AAAA', 'v=DKIM1; k=rsa; p=BBBB']);
		expect(dkim.every((r) => r.pendingKey === undefined)).toBe(true);
	});

	it('publishes _dmarc under each sending subdomain, not only at the root', () => {
		const dmarc = records.filter((r) => r.purpose === 'dmarc');
		expect(dmarc.map((r) => r.host)).toEqual([
			'_dmarc.mail.example.com',
			'_dmarc.news.example.com',
		]);
		expect(dmarc[0]?.value).toBe('v=DMARC1; p=none');
		expect(dmarc[0]?.relativeHost).toBe('_dmarc.mail');
	});

	it('threads the policy and the rua mailbox into every DMARC row', () => {
		const { records: strict } = generateStreamSubdomainRecords({
			...BASE,
			dmarcPolicy: 'quarantine',
			dmarcRua: 'mailto:dmarc@example.com',
		});
		for (const row of strict.filter((r) => r.purpose === 'dmarc')) {
			expect(row.value).toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com');
		}
	});

	it('includes the bounces/VERP host: its own SPF plus the DSN MX', () => {
		const bounce = forHost('bounces.example.com');
		expect(bounce.map((r) => r.purpose).sort()).toEqual(['mx', 'spf']);
		const mx = bounce.find((r) => r.purpose === 'mx');
		expect(mx?.type).toBe('MX');
		expect(mx?.value).toBe('mta.example.com');
		expect(mx?.priority).toBe(10);
		expect(bounce.find((r) => r.purpose === 'spf')?.value).toContain('ip4:203.0.113.10');
	});

	it('authorises a relay arm on the SAME record rather than a second one', () => {
		const { records: withRelay } = generateStreamSubdomainRecords({
			...BASE,
			relaySpfTerms: ['include:amazonses.com'],
		});
		const spf = withRelay.filter((r) => r.purpose === 'spf' && r.subdomain === 'news.example.com');
		expect(spf).toHaveLength(1);
		expect(spf[0]?.value).toBe(
			'v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 include:amazonses.com ~all'
		);
	});

	it('renders rather than throws on a malformed pool IP', () => {
		const { records: degraded } = generateStreamSubdomainRecords({
			...BASE,
			sendingIps: ['not-an-ip', '203.0.113.10'],
		});
		expect(
			degraded.find((r) => r.purpose === 'spf' && r.subdomain === 'mail.example.com')?.value
		).toBe('v=spf1 ip4:203.0.113.10 ~all');
	});
});
