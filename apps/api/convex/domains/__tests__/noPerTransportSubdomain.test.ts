/**
 * P4-7 — THE D11 GUARD.
 *
 * "NEVER GIVE THE TWO ARMS OF A CELL DIFFERENT SENDING IDENTITIES. Same From
 * domain, same d=, same Message-ID scheme, same tracking […]; only Received
 * headers and the DKIM SELECTOR differ. Per-STREAM subdomains are correct and
 * are P4-7's job; PER-TRANSPORT subdomains split domain reputation, make the
 * arms incomparable, and throw away the reputation the relay arm spent weeks
 * building."
 *
 * This suite exists so that a future edit which gives the own-MTA arm its own
 * subdomain fails here instead of shipping.
 */

import { describe, expect, it } from 'vitest';
import { GOVERNED_MESSAGE_TYPES } from '@owlat/shared';
import { generateStreamSubdomainRecords } from '../streamSubdomainRecords';
import {
	findPerTransportSubdomainViolations,
	planStreamSubdomains,
	resolveCellSendingIdentity,
	type TransportArm,
} from '../streamSubdomains';

const LAYOUT = planStreamSubdomains({ domain: 'example.com', dkimSelectorBase: 's1711' });

describe('both arms of a cell share one sending identity', () => {
	it('From domain, d= and return path are identical across the arms', () => {
		expect(findPerTransportSubdomainViolations(LAYOUT)).toEqual([]);
	});

	it.each(GOVERNED_MESSAGE_TYPES)('stream %s: the arms agree field by field', (stream) => {
		const own = resolveCellSendingIdentity({ layout: LAYOUT, stream, arm: 'own' });
		const reference = resolveCellSendingIdentity({ layout: LAYOUT, stream, arm: 'reference' });
		expect(own.fromDomain).toBe(reference.fromDomain);
		expect(own.dkimDomain).toBe(reference.dkimDomain);
		expect(own.returnPathDomain).toBe(reference.returnPathDomain);
	});

	it('d= is ALWAYS the From domain — alignment is not optional', () => {
		for (const stream of GOVERNED_MESSAGE_TYPES) {
			for (const arm of ['own', 'reference'] as const) {
				const identity = resolveCellSendingIdentity({ layout: LAYOUT, stream, arm });
				expect(identity.dkimDomain).toBe(identity.fromDomain);
			}
		}
	});

	it('the ONE permitted difference is the DKIM selector', () => {
		const own = resolveCellSendingIdentity({ layout: LAYOUT, stream: 'campaign', arm: 'own' });
		const reference = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'campaign',
			arm: 'reference',
		});
		expect(own.dkimSelector).not.toBe(reference.dkimSelector);
	});

	it('a custom per-arm selector suffix still cannot move the domain', () => {
		const own = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'campaign',
			arm: 'own',
			armSelectorSuffix: { own: 'mta', reference: 'esp' },
		});
		const reference = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'campaign',
			arm: 'reference',
			armSelectorSuffix: { own: 'mta', reference: 'esp' },
		});
		expect(own.dkimSelector).toBe('s1711-news-mta');
		expect(reference.dkimSelector).toBe('s1711-news-esp');
		expect(own.fromDomain).toBe(reference.fromDomain);
		expect(own.dkimDomain).toBe(reference.dkimDomain);
	});

	it('the STREAM is what moves the domain — per-stream is the correct axis', () => {
		const campaign = resolveCellSendingIdentity({ layout: LAYOUT, stream: 'campaign', arm: 'own' });
		const transactional = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'transactional',
			arm: 'own',
		});
		expect(campaign.fromDomain).toBe('news.example.com');
		expect(transactional.fromDomain).toBe('mail.example.com');
	});
});

describe('the generated records cannot express a per-transport subdomain', () => {
	const { records } = generateStreamSubdomainRecords({
		domain: 'example.com',
		sendingIps: ['203.0.113.10'],
		dmarcPolicy: 'none',
		mailHost: 'mta.example.com',
		dkimSelectorBase: 's1711',
		referenceArmConfigured: true,
		armSelectorSuffixes: { own: 'mta', reference: 'esp' },
	});

	it('every host lives under one of the three proposed subdomains', () => {
		const allowed = ['mail.example.com', 'news.example.com', 'bounces.example.com'];
		for (const record of records) {
			expect(allowed).toContain(record.subdomain);
			expect(record.host.endsWith(record.subdomain)).toBe(true);
		}
	});

	it('the two arms sign under the SAME subdomain with different selectors', () => {
		const dkim = records.filter((r) => r.purpose === 'dkim' && r.subdomain === 'news.example.com');
		expect(dkim).toHaveLength(2);
		const byArm = new Map<TransportArm, string>();
		for (const row of dkim) if (row.arm !== undefined) byArm.set(row.arm, row.host);
		expect(byArm.get('own')).toBe('s1711-news-mta._domainkey.news.example.com');
		expect(byArm.get('reference')).toBe('s1711-news-esp._domainkey.news.example.com');
	});

	it('no record host contains a transport name as a SUBDOMAIN label', () => {
		// A selector may name the transport (`…-mta._domainkey.…`); a SUBDOMAIN
		// may not (`mta.example.com`, `relay.example.com`, `esp.example.com`).
		for (const record of records) {
			const labels = record.subdomain.split('.');
			expect(labels[0]).not.toBe('mta');
			expect(labels[0]).not.toBe('relay');
			expect(labels[0]).not.toBe('esp');
		}
	});

	it('one SPF record per host authorises BOTH arms, never one per arm', () => {
		const spfHosts = records.filter((r) => r.purpose === 'spf').map((r) => r.host);
		expect(new Set(spfHosts).size).toBe(spfHosts.length);
	});

	it('the reference arm is absent by default — standalone is the default', () => {
		const { records: standalone } = generateStreamSubdomainRecords({
			domain: 'example.com',
			sendingIps: ['203.0.113.10'],
			dmarcPolicy: 'none',
		});
		const dkim = standalone.filter((r) => r.purpose === 'dkim');
		expect(dkim).toHaveLength(2); // one per SENDING SUBDOMAIN, own arm only
		expect(dkim.every((r) => r.arm === 'own')).toBe(true);
	});
});
