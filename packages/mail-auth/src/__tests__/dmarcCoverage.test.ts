/**
 * Branch coverage for `dmarc.ts` beyond the frozen `inboundAuth.dmarc.test.ts`
 * verdict suite: the unparseable-From short-circuit, the `parsePolicy` keyword
 * table (including the invalid-`p=` → record-ignored path), and the production
 * `dnsDmarcLookup` resolver (NXDOMAIN/NODATA → null, non-void re-throw, and the
 * `v=DMARC1` join/filter over concatenated TXT chunks). These paths are pure
 * (the DNS resolver is injected), so no real network is touched.
 */

import { describe, it, expect } from 'vitest';
import { evaluateDmarc, dnsDmarcLookup, type DmarcPolicyLookup } from '../dmarc.js';

const neverLookup: DmarcPolicyLookup = async () => {
	throw new Error('policyLookup must not be called for an unparseable From');
};

describe('evaluateDmarc — From-domain parsing', () => {
	it('returns none for a blank / unparseable From domain (no lookup)', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: '   ',
			spf: { result: 'pass', domain: 'anything.example' },
			dkim: { result: 'none' },
			policyLookup: neverLookup,
		});
		expect(outcome.result).toBe('none');
		expect(outcome.policy).toBeUndefined();
	});
});

describe('evaluateDmarc — parsePolicy keyword table', () => {
	it('honours an explicit p=none policy on an aligned pass', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'monitor.example',
			spf: { result: 'pass', domain: 'monitor.example' },
			dkim: { result: 'none' },
			policyLookup: async () => 'v=DMARC1; p=none',
		});
		expect(outcome.result).toBe('pass');
		expect(outcome.policy).toBe('none');
	});

	it('honours a p=quarantine policy on an unaligned message', async () => {
		const outcome = await evaluateDmarc({
			fromDomain: 'shop.example',
			spf: { result: 'pass', domain: 'evil.example' },
			dkim: { result: 'none' },
			policyLookup: async () => 'v=DMARC1; p=quarantine',
		});
		expect(outcome.result).toBe('fail');
		expect(outcome.policy).toBe('quarantine');
	});

	it('ignores a record whose p= tag is unrecognised (treated as no record)', async () => {
		// An invalid `p=` value → parsePolicy returns undefined → parseRecord
		// returns null → no policy is published → result none.
		const outcome = await evaluateDmarc({
			fromDomain: 'typo.example',
			spf: { result: 'fail', domain: 'whatever.example' },
			dkim: { result: 'none' },
			policyLookup: async (domain) => (domain === 'typo.example' ? 'v=DMARC1; p=bogus' : null),
		});
		expect(outcome.result).toBe('none');
		expect(outcome.policy).toBeUndefined();
	});
});

describe('dnsDmarcLookup — production TXT resolver', () => {
	it('joins concatenated TXT chunks and returns the v=DMARC1 record', async () => {
		const resolveTxt = async (name: string): Promise<string[][]> => {
			expect(name).toBe('_dmarc.example.com');
			return [['v=DMARC1; ', 'p=reject'], ['some other txt']];
		};
		expect(await dnsDmarcLookup('Example.COM.', resolveTxt)).toBe('v=DMARC1; p=reject');
	});

	it('returns null when no TXT record is a DMARC record', async () => {
		const resolveTxt = async (): Promise<string[][]> => [['google-site-verification=abc']];
		expect(await dnsDmarcLookup('example.com', resolveTxt)).toBeNull();
	});

	it('maps NXDOMAIN (ENOTFOUND) to null', async () => {
		const resolveTxt = async (): Promise<string[][]> => {
			throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
		};
		expect(await dnsDmarcLookup('example.com', resolveTxt)).toBeNull();
	});

	it('maps NODATA (ENODATA) to null', async () => {
		const resolveTxt = async (): Promise<string[][]> => {
			throw Object.assign(new Error('no data'), { code: 'ENODATA' });
		};
		expect(await dnsDmarcLookup('example.com', resolveTxt)).toBeNull();
	});

	it('re-throws a transient DNS error (SERVFAIL) so the caller maps it to temperror', async () => {
		const resolveTxt = async (): Promise<string[][]> => {
			throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
		};
		await expect(dnsDmarcLookup('example.com', resolveTxt)).rejects.toThrow('servfail');
	});
});
