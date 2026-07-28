/**
 * P4-7 — SINGLE-IP DEPLOYMENTS ARE THE COMMON CASE.
 *
 * Most self-hosters have exactly one IP, so the transactional and campaign
 * pools resolve to the same address and pool separation collapses. The wizard
 * must still render correctly and still give correct advice: the subdomain
 * split delivers the reputation isolation because DOMAIN reputation is doing
 * the work. Nothing in this piece may assume multiple IPs anywhere.
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
	normalizePoolIps,
	planStreamSubdomains,
	planSubdomainWarming,
	type SubdomainLayoutInput,
	type SubdomainLayoutProposal,
} from '../streamSubdomains';

const ONE_IP = ['203.0.113.10'];

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

const valueOf = (record: StreamSubdomainRecord | undefined): string | null =>
	record === undefined ? null : streamSubdomainRecordValue(record);

describe('one IP: the pools collapse and the wizard still renders', () => {
	const layout = layoutOf({ domain: 'example.com', sendingIps: ONE_IP });

	it('reports the collapse rather than pretending there are two pools', () => {
		expect(layout.poolsCollapsed).toBe(true);
		expect(layout.advice).toContain('pools_collapsed_single_ip');
		expect(layout.advice).not.toContain('pools_separated');
	});

	it('still proposes the full three-subdomain layout', () => {
		expect(layout.subdomains.map((s) => s.host)).toEqual([
			'mail.example.com',
			'news.example.com',
			'bounces.example.com',
		]);
	});

	it('keeps the pool LABELS distinct even though the address is shared', () => {
		// The labels are what the MTA's pool rules key off; a collapsed pool is a
		// deployment fact, not a reason to merge the two streams' identities.
		expect(layout.subdomainsByRole.transactional.pool).toBe('transactional');
		expect(layout.subdomainsByRole.bulk.pool).toBe('campaign');
	});

	it('gives ADVICE THAT IS TRUE with one IP', () => {
		expect(SUBDOMAIN_ADVICE_COPY.pools_collapsed_single_ip).toMatch(/one sending IP/i);
		expect(SUBDOMAIN_ADVICE_COPY.pools_collapsed_single_ip).toMatch(/domain reputation/i);
		// It must NOT promise IP separation it cannot deliver.
		expect(SUBDOMAIN_ADVICE_COPY.pools_collapsed_single_ip).not.toMatch(/own IP pool/i);
	});

	it('two IPs flip the advice to the separated wording', () => {
		const multi = layoutOf({
			domain: 'example.com',
			sendingIps: ['203.0.113.10', '203.0.113.11'],
		});
		expect(multi.poolsCollapsed).toBe(false);
		expect(multi.advice).toContain('pools_separated');
	});

	it('a repeated address is still ONE IP, whatever spelling it arrives in', () => {
		const repeated = layoutOf({
			domain: 'example.com',
			sendingIps: ['203.0.113.10', ' 203.0.113.10 '],
		});
		expect(repeated.poolsCollapsed).toBe(true);
		// IPv6 hex case is not an address difference (RFC 5952 canonical form).
		const cased = layoutOf({
			domain: 'example.com',
			sendingIps: ['2001:DB8::1', '2001:db8::1'],
		});
		expect(cased.poolsCollapsed).toBe(true);
		expect(normalizePoolIps(['2001:DB8::1', '2001:db8::1']).distinctCount).toBe(1);
	});

	it('an unparseable address is dropped, never counted as a pool', () => {
		expect(normalizePoolIps(['203.0.113.10', 'not-an-ip', ''])).toEqual({
			ip4: ['203.0.113.10'],
			ip6: [],
			distinctCount: 1,
		});
	});

	it('a relay-only deployment with NO IP renders the same way', () => {
		const relayOnly = layoutOf({ domain: 'example.com', sendingIps: [] });
		expect(relayOnly.poolsCollapsed).toBe(true);
		expect(relayOnly.subdomains).toHaveLength(3);
	});

	it('a domain with no registrable zone reports it instead of throwing', () => {
		expect(planStreamSubdomains({ domain: 'localhost', sendingIps: ONE_IP })).toEqual({
			ok: false,
			reason: 'invalid_domain',
		});
		expect(
			generateStreamSubdomainRecords({
				domain: 'localhost',
				sendingIps: ONE_IP,
				dmarcPolicy: 'none',
			})
		).toEqual({ ok: false, reason: 'invalid_domain' });
	});
});

describe('one IP: the generated records are correct', () => {
	const records = recordsOf({
		domain: 'example.com',
		sendingIps: ONE_IP,
		dmarcPolicy: 'none',
		mailHost: 'mta.example.com',
	});

	it('authorises the one address on BOTH subdomains', () => {
		const spf = records.filter((r) => r.purpose === 'spf');
		expect(spf).toHaveLength(3); // mail. + news. + bounces.
		for (const row of spf) expect(valueOf(row)).toBe('v=spf1 ip4:203.0.113.10 ~all');
	});

	it('still gives each subdomain its own DKIM selector', () => {
		const dkim = records.filter((r) => r.purpose === 'dkim');
		expect(dkim).toHaveLength(2);
		expect(new Set(dkim.map((r) => r.host)).size).toBe(2);
	});

	it('emits no record whose value depends on a second address existing', () => {
		expect(records.some((r) => (valueOf(r) ?? '').includes('203.0.113.11'))).toBe(false);
	});

	it('warms each sending subdomain separately even on one shared address', () => {
		const warming = planSubdomainWarming(layoutOf({ domain: 'example.com', sendingIps: ONE_IP }));
		expect(warming.map((w) => w.host)).toEqual(['mail.example.com', 'news.example.com']);
		expect(warming.every((w) => w.inheritsFromRoot === false)).toBe(true);
	});
});

describe('with no pool IPs the SPF record still renders', () => {
	it('emits a syntactically valid record rather than a broken one', () => {
		const records = recordsOf({
			domain: 'example.com',
			sendingIps: [],
			dmarcPolicy: 'none',
			relaySpfTerms: ['include:amazonses.com'],
		});
		const spf = records.find((r) => r.purpose === 'spf' && r.subdomain === 'news.example.com');
		expect(valueOf(spf)).toBe('v=spf1 include:amazonses.com ~all');
	});
});
