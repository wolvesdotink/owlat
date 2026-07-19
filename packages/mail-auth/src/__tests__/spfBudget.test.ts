/**
 * Moved verbatim from `apps/mta/src/bounce/__tests__/spfBudget.test.ts` when the
 * RFC 7208 SPF evaluator relocated into `@owlat/mail-auth` (Own-the-Inbound A1).
 * Only the import path was adjusted (`../inboundSecurity.js` → `../spf.js`) and
 * the no-op logger mock — the SPF evaluator never imported a logger — was
 * dropped. Every assertion is unchanged: the frozen logic must pass verbatim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('dns/promises', () => ({ resolve: resolveMock }));

import { checkSpf } from '../spf.js';

/** Configure the fake resolver from a domain -> SPF record map. */
function dnsWith(spfByDomain: Record<string, string>) {
	resolveMock.mockImplementation(async (domain: string, type: string) => {
		if (type === 'TXT') {
			const record = spfByDomain[domain];
			if (!record) {
				const err = new Error('ENOTFOUND') as Error & { code: string };
				err.code = 'ENOTFOUND';
				throw err;
			}
			return [[record]];
		}
		if (type === 'A') return ['9.9.9.9'];
		if (type === 'MX') return [{ exchange: `mx.${domain}`, priority: 10 }];
		return [];
	});
}

beforeEach(() => {
	resolveMock.mockReset();
});

describe('checkSpf — RFC 7208 lookup budget', () => {
	it('still passes a simple ip4 record', async () => {
		dnsWith({ 'good.com': 'v=spf1 ip4:1.2.3.4 -all' });
		const result = await checkSpf('1.2.3.4', 'user@good.com', 'ehlo.host');
		expect(result.result).toBe('pass');
	});

	it('terminates a two-domain include cycle with permerror', async () => {
		dnsWith({
			'a.com': 'v=spf1 include:b.com +all',
			'b.com': 'v=spf1 include:a.com +all',
		});
		const result = await checkSpf('5.5.5.5', 'user@a.com', 'ehlo.host');
		expect(result.result).toBe('permerror');
		// 1 initial TXT + 1 include TXT + cycle detected — nowhere near unbounded.
		expect(resolveMock.mock.calls.length).toBeLessThan(5);
	});

	it('rejects a domain that includes itself', async () => {
		dnsWith({ 'self.com': 'v=spf1 include:self.com +all' });
		const result = await checkSpf('5.5.5.5', 'user@self.com', 'ehlo.host');
		expect(result.result).toBe('permerror');
	});

	it('caps total DNS-causing mechanisms at 10', async () => {
		// A linear chain of 12 includes — must stop at the RFC ceiling.
		const chain: Record<string, string> = {};
		for (let i = 0; i < 12; i++) {
			chain[`d${i}.com`] = `v=spf1 include:d${i + 1}.com -all`;
		}
		chain['d12.com'] = 'v=spf1 +all';
		dnsWith(chain);
		const result = await checkSpf('5.5.5.5', 'user@d0.com', 'ehlo.host');
		expect(result.result).toBe('permerror');
		// initial TXT + at most 10 budgeted lookups
		expect(resolveMock.mock.calls.length).toBeLessThanOrEqual(11);
	});

	it('counts a/mx mechanisms against the same budget', async () => {
		const mechanisms = Array.from({ length: 11 }, (_, i) => `a:host${i}.com`).join(' ');
		dnsWith({ 'many.com': `v=spf1 ${mechanisms} -all` });
		const result = await checkSpf('5.5.5.5', 'user@many.com', 'ehlo.host');
		expect(result.result).toBe('permerror');
	});
});

// ─── RFC 7208 parser correctness (PR-69) ─────────────────────────────

const ENOTFOUND = (): never => {
	const err = new Error('ENOTFOUND') as Error & { code: string };
	err.code = 'ENOTFOUND';
	throw err;
};
const SERVFAIL = (): never => {
	const err = new Error('SERVFAIL') as Error & { code: string };
	err.code = 'ESERVFAIL';
	throw err;
};

describe('checkSpf — redirect= modifier (RFC 7208 §6.1)', () => {
	it('follows a redirect chain r.com -> _spf.r.com and yields pass', async () => {
		resolveMock.mockImplementation(async (domain: string, type: string) => {
			if (type !== 'TXT') return [];
			if (domain === 'r.com') return [['v=spf1 redirect=_spf.r.com']];
			if (domain === '_spf.r.com') return [['v=spf1 ip4:7.7.7.7 -all']];
			return ENOTFOUND();
		});
		const result = await checkSpf('7.7.7.7', 'user@r.com', 'ehlo.host');
		expect(result.result).toBe('pass');
	});

	it('redirect= to a domain with no SPF record is a permerror', async () => {
		resolveMock.mockImplementation(async (domain: string, type: string) => {
			if (type !== 'TXT') return [];
			if (domain === 'r.com') return [['v=spf1 redirect=missing.com']];
			return ENOTFOUND();
		});
		const result = await checkSpf('7.7.7.7', 'user@r.com', 'ehlo.host');
		expect(result.result).toBe('permerror');
	});
});

describe('checkSpf — exists: mechanism (RFC 7208 §5.7)', () => {
	it('macro-expands %{i} and passes when the A record exists', async () => {
		resolveMock.mockImplementation(async (domain: string, type: string) => {
			if (type === 'TXT') {
				if (domain === 'r.com') return [['v=spf1 exists:%{i}._spf.r.com -all']];
				return ENOTFOUND();
			}
			if (type === 'A') {
				// The sender IP 5.5.5.5 expands into the exists: target.
				if (domain === '5.5.5.5._spf.r.com') return ['127.0.0.2'];
				return ENOTFOUND();
			}
			return [];
		});
		const result = await checkSpf('5.5.5.5', 'user@r.com', 'ehlo.host');
		expect(result.result).toBe('pass');
	});
});

describe('checkSpf — include temp failure (RFC 7208 §5.2)', () => {
	it('maps an include TXT SERVFAIL to temperror, not neutral/fail', async () => {
		resolveMock.mockImplementation(async (domain: string, type: string) => {
			if (type !== 'TXT') return [];
			// down.com TXT fails transiently; the sender is NOT in the fallthrough ip4.
			if (domain === 'main.com') return [['v=spf1 include:down.com ip4:1.1.1.1 -all']];
			if (domain === 'down.com') return SERVFAIL();
			return ENOTFOUND();
		});
		const result = await checkSpf('9.9.9.9', 'user@main.com', 'ehlo.host');
		expect(result.result).toBe('temperror');
	});
});

describe('checkSpf — ip6 CIDR prefix match (RFC 7208 §5.6, PR-40)', () => {
	it('passes a sender inside an ip6:.../32 prefix', async () => {
		dnsWith({ 'ms.com': 'v=spf1 ip6:2001:db8::/32 -all' });
		const result = await checkSpf('2001:db8:1234::5', 'user@ms.com', 'ehlo.host');
		// Old exact-match code scored this non-matching → fell through to `-all`.
		expect(result.result).toBe('pass');
	});

	it('fails a sender outside the ip6:.../32 prefix', async () => {
		dnsWith({ 'ms.com': 'v=spf1 ip6:2001:db8::/32 -all' });
		const result = await checkSpf('2001:dead::1', 'user@ms.com', 'ehlo.host');
		expect(result.result).toBe('fail');
	});

	it('still passes an exact bare ip6 address (no prefix)', async () => {
		dnsWith({ 'ms.com': 'v=spf1 ip6:2001:db8::5 -all' });
		const result = await checkSpf('2001:db8::5', 'user@ms.com', 'ehlo.host');
		expect(result.result).toBe('pass');
	});

	it('matches on a non-nibble-aligned prefix length (/33)', async () => {
		// /33 = first 8 nibbles (2001:db80) equal + the high bit of the 9th nibble.
		// The network's 9th nibble is 0 (high bit clear), so a sender whose 9th
		// nibble has the high bit clear (0–7) matches; one with it set (8–f) does not.
		dnsWith({ 'ms.com': 'v=spf1 ip6:2001:db80::/33 -all' });
		expect((await checkSpf('2001:db80:7000::1', 'user@ms.com', 'ehlo.host')).result).toBe('pass');
		expect((await checkSpf('2001:db80:8000::1', 'user@ms.com', 'ehlo.host')).result).toBe('fail');
	});
});

describe('checkSpf — void-lookup cap (RFC 7208 §4.6.4)', () => {
	it('permerrors after 3 void a: lookups and stops issuing A queries', async () => {
		resolveMock.mockImplementation(async (domain: string, type: string) => {
			if (type === 'TXT') {
				if (domain === 'void.com') {
					return [['v=spf1 a:v1.com a:v2.com a:v3.com a:v4.com -all']];
				}
				return ENOTFOUND();
			}
			if (type === 'A') {
				// Every a: target is an empty (NODATA) answer — i.e. a void lookup.
				return [];
			}
			return [];
		});
		const result = await checkSpf('5.5.5.5', 'user@void.com', 'ehlo.host');
		expect(result.result).toBe('permerror');
		expect(result.explanation ?? '').toMatch(/void/i);

		// The §4.6.4 cap is 2 voids; the 3rd aborts evaluation, so only the first
		// three a: targets are ever resolved — v4.com is never queried.
		const aLookups = resolveMock.mock.calls.filter(([, type]) => type === 'A');
		expect(aLookups.length).toBe(3);
		expect(aLookups.some(([d]) => d === 'v4.com')).toBe(false);
	});
});
