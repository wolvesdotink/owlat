import { formatDnsTierAnswer } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import { joinTxtChunks, lookupTierViaDns, tierQueryName } from '../dns.js';
import { dnsError, fakeTxtResolver, ZONE } from './fixtures.js';

const TXT = formatDnsTierAnswer({
	v: 1,
	tier: 'trusted',
	score: 87,
	policy: 'ostr-policy-v1',
	asof: '2026-08-20T06:00:00Z',
});

describe('tierQueryName', () => {
	it('queries a domain under q.<zone>', () => {
		expect(tierQueryName({ domain: 'example.com' }, ZONE)).toBe('example.com.q.ostr.example');
	});

	it('normalizes the domain a caller passes from a mail header', () => {
		expect(tierQueryName({ domain: ' Example.COM. ' }, ZONE)).toBe('example.com.q.ostr.example');
	});

	it('reverses an IPv4 address', () => {
		expect(tierQueryName({ ip: '192.0.2.7' }, ZONE)).toBe('7.2.0.192.ip.q.ostr.example');
	});

	it('reverses an IPv6 address by nibble, in any spelling', () => {
		const canonical = tierQueryName({ ip: '2001:db8::1' }, ZONE);
		expect(canonical).toBe(tierQueryName({ ip: '2001:0DB8:0000:0000:0000:0000:0000:0001' }, ZONE));
		expect(canonical?.split('.')).toHaveLength(32 + 4);
	});

	it('prefers the domain when the subject carries both (plan D2)', () => {
		expect(tierQueryName({ domain: 'example.com', ip: '192.0.2.7' }, ZONE)).toBe(
			'example.com.q.ostr.example'
		);
	});

	it.each([{}, { ip: 'not-an-ip' }, { domain: '   ' }, { ip: '' }])(
		'has no name for %p',
		(subject) => {
			expect(tierQueryName(subject, ZONE)).toBeNull();
		}
	);
});

describe('lookupTierViaDns', () => {
	it('parses the answer served at the query name', async () => {
		const resolver = fakeTxtResolver({ 'example.com.q.ostr.example': [[TXT]] });
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
		});

		expect(result).toEqual({
			status: 'answer',
			name: 'example.com.q.ostr.example',
			answer: {
				v: 1,
				tier: 'trusted',
				score: 87,
				policy: 'ostr-policy-v1',
				asof: '2026-08-20T06:00:00Z',
			},
		});
		expect(resolver.calls).toEqual(['example.com.q.ostr.example']);
	});

	it('joins the chunks of a TXT record split at 255 bytes', async () => {
		const chunks = [TXT.slice(0, 40), TXT.slice(40)];
		expect(joinTxtChunks(chunks)).toBe(TXT);
		const resolver = fakeTxtResolver({ 'example.com.q.ostr.example': [chunks] });
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
		});
		expect(result.status).toBe('answer');
	});

	it('reads an empty record set as not-found', async () => {
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.resolve([]),
		});
		expect(result).toEqual({ status: 'not-found', name: 'example.com.q.ostr.example' });
	});

	it.each(['ENOTFOUND', 'ENODATA', 'NXDOMAIN'])(
		'reads a %s rejection as not-found',
		async (code) => {
			const result = await lookupTierViaDns({
				subject: { domain: 'example.com' },
				zone: ZONE,
				resolveTxt: () => Promise.reject(dnsError(code)),
			});
			expect(result.status).toBe('not-found');
		}
	);

	it('reports SERVFAIL as an error, not as an unscored sender', async () => {
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.reject(dnsError('ESERVFAIL')),
		});
		expect(result.status).toBe('error');
		if (result.status !== 'error') return;
		expect(result.errors[0]).toContain('resolver failed');
	});

	it('reports a resolver that rejects with something other than an Error', async () => {
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.reject('boom' as unknown as Error),
		});
		expect(result.status).toBe('error');
	});

	it('reports the parse errors of an unparseable answer', async () => {
		const resolver = fakeTxtResolver({ 'example.com.q.ostr.example': [['v=spf1 -all']] });
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
		});
		expect(result.status).toBe('error');
		if (result.status !== 'error') return;
		expect(result.errors.join(' ')).toContain('record 0:');
	});

	it('refuses to choose between two parseable answers at one name', async () => {
		const other = formatDnsTierAnswer({
			v: 1,
			tier: 'flagged',
			score: 3,
			policy: 'ostr-policy-v1',
			asof: '2026-08-20T06:00:00Z',
		});
		const resolver = fakeTxtResolver({ 'example.com.q.ostr.example': [[TXT], [other]] });
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
		});
		expect(result.status).toBe('error');
		if (result.status !== 'error') return;
		expect(result.errors[0]).toContain('expected one TXT answer, got 2');
	});

	it('still answers when an unrelated TXT record shares the name', async () => {
		const resolver = fakeTxtResolver({
			'example.com.q.ostr.example': [['v=spf1 -all'], [TXT]],
		});
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
		});
		expect(result.status).toBe('answer');
	});

	it('carries the record TTL when the resolver exposes one', async () => {
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.resolve({ records: [[TXT]], ttlSeconds: 300 }),
		});
		expect(result).toMatchObject({ status: 'answer', ttlSeconds: 300 });
	});

	it.each([
		['a negative TTL', -1],
		['a NaN TTL', Number.NaN],
		['an infinite TTL', Number.POSITIVE_INFINITY],
	])('ignores %s rather than caching on it', async (_label, ttlSeconds) => {
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.resolve({ records: [[TXT]], ttlSeconds }),
		});
		expect(result.status).toBe('answer');
		if (result.status !== 'answer') return;
		expect(result.ttlSeconds).toBeUndefined();
	});

	it('rounds a fractional TTL down', async () => {
		const result = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.resolve({ records: [[TXT]], ttlSeconds: 59.9 }),
		});
		expect(result).toMatchObject({ ttlSeconds: 59 });
	});

	it('reads a record set with no records, or a broken one, as not-found', async () => {
		const empty = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.resolve({ records: [] }),
		});
		expect(empty.status).toBe('not-found');
		const broken = await lookupTierViaDns({
			subject: { domain: 'example.com' },
			zone: ZONE,
			resolveTxt: () => Promise.resolve({ records: null } as unknown as { records: string[][] }),
		});
		expect(broken.status).toBe('not-found');
	});

	it('does not query at all for a subject with no name', async () => {
		const resolver = fakeTxtResolver({});
		const result = await lookupTierViaDns({
			subject: { ip: '999.1.1.1' },
			zone: ZONE,
			resolveTxt: resolver.resolveTxt,
		});
		expect(result.status).toBe('error');
		expect(resolver.calls).toEqual([]);
	});
});
