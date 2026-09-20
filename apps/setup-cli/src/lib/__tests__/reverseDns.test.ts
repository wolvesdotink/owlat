import { describe, expect, it } from 'vitest';
import {
	checkReverseDns,
	isPubliclyRoutable,
	plannedOutboundIdentities,
	reverseDnsInstructions,
} from '../reverseDns.js';
import type { FcrdnsDnsDeps } from '@owlat/shared/fcrdns';

/** A resolver fixture: PTR names per IP, forward addresses per hostname. */
function dns(ptr: Record<string, string[]>, forward: Record<string, string[]>): FcrdnsDnsDeps {
	return {
		reverse: async (ip) => ptr[ip] ?? [],
		resolve4: async (host) => forward[host] ?? [],
		resolve6: async (host) => forward[host] ?? [],
	};
}

describe('plannedOutboundIdentities', () => {
	it('unions both pools and pairs each address with the default EHLO name', () => {
		expect(
			plannedOutboundIdentities({
				IP_POOLS_TRANSACTIONAL: '203.0.113.10, 203.0.113.11',
				IP_POOLS_CAMPAIGN: '203.0.113.11',
				EHLO_HOSTNAME: 'mail.example.com',
			})
		).toEqual([
			{ ip: '203.0.113.10', ehlo: 'mail.example.com', recordType: 'A' },
			{ ip: '203.0.113.11', ehlo: 'mail.example.com', recordType: 'A' },
		]);
	});

	it('honours per-IP EHLO overrides and marks IPv6 as an AAAA forward record', () => {
		expect(
			plannedOutboundIdentities({
				IP_POOLS_TRANSACTIONAL: '203.0.113.10,2001:db8::10',
				EHLO_HOSTNAME: 'mail.example.com',
				EHLO_HOSTNAMES: JSON.stringify({ '2001:db8::10': 'mail6.example.com' }),
			})
		).toEqual([
			{ ip: '203.0.113.10', ehlo: 'mail.example.com', recordType: 'A' },
			{ ip: '2001:db8::10', ehlo: 'mail6.example.com', recordType: 'AAAA' },
		]);
	});

	it('stays silent when there is no EHLO hostname to ask for a PTR of', () => {
		expect(plannedOutboundIdentities({ IP_POOLS_TRANSACTIONAL: '203.0.113.10' })).toEqual([]);
	});
});

describe('isPubliclyRoutable', () => {
	it.each(['127.0.0.1', '::1', '10.1.2.3', '192.168.1.5', '172.16.0.4', '169.254.1.1', 'fd00::1'])(
		'rejects %s',
		(ip) => {
			expect(isPubliclyRoutable(ip)).toBe(false);
		}
	);

	it.each(['203.0.113.10', '2001:db8::10', '172.15.0.1', '172.32.0.1'])('accepts %s', (ip) => {
		expect(isPubliclyRoutable(ip)).toBe(true);
	});
});

describe('checkReverseDns', () => {
	const identity = { ip: '203.0.113.10', ehlo: 'mail.example.com', recordType: 'A' as const };

	it('reports a forward-confirmed PTR as ready', async () => {
		const [finding] = await checkReverseDns(
			[identity],
			{},
			dns({ '203.0.113.10': ['mail.example.com'] }, { 'mail.example.com': ['203.0.113.10'] })
		);
		expect(finding).toMatchObject({ ready: true, ptrNames: ['mail.example.com'] });
		expect(finding?.problem).toBeUndefined();
	});

	it('names the provider console when the PTR is still the host default', async () => {
		const [finding] = await checkReverseDns(
			[identity],
			{},
			dns(
				{ '203.0.113.10': ['static.10.113.0.203.clients.your-server.de'] },
				{
					'static.10.113.0.203.clients.your-server.de': ['203.0.113.10'],
					'mail.example.com': ['203.0.113.10'],
				}
			)
		);
		expect(finding?.ready).toBe(false);
		expect(finding?.instruction).toContain('Hetzner Console');
	});

	it('flags a missing PTR', async () => {
		const [finding] = await checkReverseDns([identity], {}, dns({}, {}));
		expect(finding).toMatchObject({ ready: false, ptrNames: [] });
		expect(finding?.problem).toContain('No PTR record');
	});

	it('does not ask for a PTR on a non-public address', async () => {
		const [finding] = await checkReverseDns(
			[{ ip: '127.0.0.1', ehlo: 'mail.example.com', recordType: 'A' }],
			{},
			dns({ '127.0.0.1': ['localhost'] }, {})
		);
		expect(finding?.ready).toBe(false);
		expect(finding?.problem).toContain('IP_POOLS_TRANSACTIONAL');
	});
});

describe('reverseDnsInstructions', () => {
	it('says nothing when every address is ready', () => {
		expect(
			reverseDnsInstructions([
				{
					ip: '203.0.113.10',
					ehlo: 'mail.example.com',
					recordType: 'A',
					ptrNames: ['mail.example.com'],
					ready: true,
					instruction: 'irrelevant',
				},
			])
		).toEqual([]);
	});

	it('states the exact record, the current value, and where to change it', () => {
		const text = reverseDnsInstructions([
			{
				ip: '203.0.113.10',
				ehlo: 'mail.example.com',
				recordType: 'A',
				ptrNames: ['static.10.113.0.203.clients.your-server.de'],
				ready: false,
				problem: 'The PTR hostname does not match the EHLO hostname announced by the MTA.',
				instruction: 'In Hetzner Console, open Servers → …',
			},
		]).join('\n');
		expect(text).toContain('203.0.113.10  PTR  mail.example.com');
		expect(text).toContain('today: static.10.113.0.203.clients.your-server.de');
		expect(text).toContain('In Hetzner Console');
		expect(text).toContain('mail.example.com  A  203.0.113.10');
		expect(text).toContain('owlat doctor');
	});

	it('says so when no PTR exists at all', () => {
		const text = reverseDnsInstructions([
			{
				ip: '2001:db8::10',
				ehlo: 'mail6.example.com',
				recordType: 'AAAA',
				ptrNames: [],
				ready: false,
				problem: 'No PTR record exists for this sending IP.',
				instruction: "Open your VPS provider's reverse-DNS/PTR settings for this public IP.",
			},
		]).join('\n');
		expect(text).toContain('no PTR record today');
		expect(text).toContain('mail6.example.com  AAAA  2001:db8::10');
	});
});
