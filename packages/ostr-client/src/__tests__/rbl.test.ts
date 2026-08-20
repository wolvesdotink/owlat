import { ipQueryName } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { isLoopbackAnswer, rblLookup, rblQueryName } from '../rbl.js';
import { dnsError, fakeAResolver, ZONE } from './fixtures.js';

describe('rblQueryName', () => {
	it('puts a domain directly under the view zone, RHSBL style', () => {
		expect(rblQueryName({ domain: 'spammer.example' }, 'bl', ZONE)).toBe(
			'spammer.example.bl.ostr.example'
		);
		expect(rblQueryName({ domain: 'good.example' }, 'wl', ZONE)).toBe(
			'good.example.wl.ostr.example'
		);
	});

	it('reverses IPv4 without the TXT zone`s ip. label, as stock RBL clients do', () => {
		expect(rblQueryName({ ip: '192.0.2.7' }, 'bl', ZONE)).toBe('7.2.0.192.bl.ostr.example');
	});

	it('reverses IPv6 by nibble under the view zone', () => {
		const name = rblQueryName({ ip: '2001:db8::1' }, 'bl', ZONE);
		expect(name?.endsWith('.bl.ostr.example')).toBe(true);
		expect(name?.slice(0, -'.bl.ostr.example'.length).split('.')).toHaveLength(32);
	});

	it.each([{}, { ip: 'nonsense' }])('has no name for %p', (subject) => {
		expect(rblQueryName(subject, 'bl', ZONE)).toBeNull();
	});

	it('builds the same reversed labels core`s TXT name carries', () => {
		// Pins the two name layouts against each other: the view name is core's
		// reversal with the `ip.q.` labels removed, and nothing else.
		const txt = ipQueryName('192.0.2.7', ZONE);
		const view = rblQueryName({ ip: '192.0.2.7' }, 'bl', ZONE);
		expect(txt).toBe(`7.2.0.192.ip.q.${ZONE}`);
		expect(view).toBe(`${txt.slice(0, -`.ip.q.${ZONE}`.length)}.bl.${ZONE}`);
	});
});

describe('rblLookup', () => {
	it('reports a listing from a 127.0.0.x answer', async () => {
		const resolver = fakeAResolver({ '7.2.0.192.bl.ostr.example': ['127.0.0.2'] });
		const result = await rblLookup({
			subject: { ip: '192.0.2.7' },
			view: 'bl',
			zone: ZONE,
			resolveA: resolver.resolveA,
		});
		expect(result).toEqual({
			status: 'listed',
			name: '7.2.0.192.bl.ostr.example',
			addresses: ['127.0.0.2'],
		});
	});

	it('reports NXDOMAIN as not-listed, which is what an absent listing looks like', async () => {
		const result = await rblLookup({
			subject: { domain: 'nobody.example' },
			view: 'wl',
			zone: ZONE,
			resolveA: () => Promise.reject(dnsError('ENOTFOUND')),
		});
		expect(result.status).toBe('not-listed');
	});

	it('reports an empty answer as not-listed', async () => {
		const result = await rblLookup({
			subject: { domain: 'nobody.example' },
			view: 'bl',
			zone: ZONE,
			resolveA: () => Promise.resolve([]),
		});
		expect(result.status).toBe('not-listed');
	});

	it('refuses to treat an answer outside 127.0.0.0/8 as a listing', async () => {
		// The shape of a "your resolver is blocked" answer. Reading it as a hit
		// would reject a sender's mail on the strength of an upstream error.
		const result = await rblLookup({
			subject: { ip: '192.0.2.7' },
			view: 'bl',
			zone: ZONE,
			resolveA: () => Promise.resolve(['203.0.113.9']),
		});
		expect(result.status).toBe('error');
		if (result.status !== 'error') return;
		expect(result.errors[0]).toContain('outside 127.0.0.0/8');
	});

	it('keeps only the loopback answers when a view returns several', async () => {
		const result = await rblLookup({
			subject: { ip: '192.0.2.7' },
			view: 'bl',
			zone: ZONE,
			resolveA: () => Promise.resolve(['127.0.0.2', '203.0.113.9', '127.0.0.10']),
		});
		expect(result).toMatchObject({ status: 'listed', addresses: ['127.0.0.2', '127.0.0.10'] });
	});

	it('reports a resolver failure as an error', async () => {
		const result = await rblLookup({
			subject: { ip: '192.0.2.7' },
			view: 'bl',
			zone: ZONE,
			resolveA: () => Promise.reject(dnsError('ESERVFAIL')),
		});
		expect(result.status).toBe('error');
	});

	it('does not query for a subject it cannot name', async () => {
		const resolver = fakeAResolver({});
		const result = await rblLookup({
			subject: {},
			view: 'bl',
			zone: ZONE,
			resolveA: resolver.resolveA,
		});
		expect(result.status).toBe('error');
		expect(resolver.calls).toEqual([]);
	});

	it.each([
		['127.0.0.2', true],
		['127.255.255.254', true],
		['128.0.0.1', false],
		['27.0.0.2', false],
		['', false],
		['::1', false],
		// Not addresses at all. A validator that waves these through is not
		// validating, and the answer it green-lights rejects someone's mail.
		['127.999.0.1', false],
		['127.0.0.256', false],
		['127.0.0', false],
		['127.0.0.1.5', false],
		['127.0.0.x', false],
	])('classifies %s as loopback=%s', (address, expected) => {
		expect(isLoopbackAnswer(address)).toBe(expected);
	});
});
