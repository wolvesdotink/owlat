/**
 * Extra branch coverage for the `redirect=` modifier and qualifier mapping in
 * `spf.ts` (RFC 7208 §6.1 / §4.6.4) that the frozen `spfBudget.test.ts` does not
 * reach: a redirect that cycles, a redirect that trips the 10-lookup budget, a
 * redirect whose TXT lookup fails transiently (→ temperror), and the `~`/`?`
 * qualifier results. The resolver is injected so no real DNS is touched.
 */

import { describe, it, expect } from 'vitest';
import { checkSpf, type SpfDnsResolver } from '../spf.js';

const notFound = (): never => {
	throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
};
const servfail = (): never => {
	throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
};

/** Build an injected resolver from a per-type domain lookup table. */
function resolverFrom(
	txt: Record<string, string>,
	a: Record<string, string[]> = {}
): SpfDnsResolver {
	return async (name, type) => {
		if (type === 'TXT') {
			const rec = txt[name];
			if (rec === undefined) return notFound();
			return [[rec]] as unknown[];
		}
		if (type === 'A') return (a[name] ?? []) as unknown[];
		return [] as unknown[];
	};
}

describe('checkSpf — redirect= edge cases (RFC 7208 §6.1)', () => {
	it('permerrors on a redirect that cycles back to the current domain', async () => {
		const resolver = resolverFrom({ 'loop.com': 'v=spf1 redirect=loop.com' });
		const result = await checkSpf('7.7.7.7', 'user@loop.com', 'ehlo.host', resolver);
		expect(result.result).toBe('permerror');
		expect(result.explanation ?? '').toMatch(/cycle/i);
	});

	it('permerrors when the redirect would exceed the 10-lookup budget', async () => {
		// Ten non-matching a: mechanisms consume the whole §4.6.4 budget, so the
		// trailing redirect can never be followed.
		const aMechs = Array.from({ length: 10 }, (_, i) => `a:h${i}.com`).join(' ');
		const aTable: Record<string, string[]> = {};
		for (let i = 0; i < 10; i++) aTable[`h${i}.com`] = ['9.9.9.9']; // non-void, non-match
		const resolver = resolverFrom(
			{ 'busy.com': `v=spf1 ${aMechs} redirect=_spf.busy.com`, '_spf.busy.com': 'v=spf1 +all' },
			aTable
		);
		const result = await checkSpf('1.1.1.1', 'user@busy.com', 'ehlo.host', resolver);
		expect(result.result).toBe('permerror');
		expect(result.explanation ?? '').toMatch(/lookup limit/i);
	});

	it('maps a transient redirect TXT failure to temperror', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type !== 'TXT') return [] as unknown[];
			if (name === 'r.com') return [['v=spf1 redirect=down.com']] as unknown[];
			if (name === 'down.com') return servfail();
			return notFound();
		};
		const result = await checkSpf('7.7.7.7', 'user@r.com', 'ehlo.host', resolver);
		expect(result.result).toBe('temperror');
		expect(result.explanation ?? '').toMatch(/redirect/i);
	});
});

describe('checkSpf — qualifier mapping', () => {
	it('maps ~all to softfail', async () => {
		const resolver = resolverFrom({ 'sf.com': 'v=spf1 ~all' });
		const result = await checkSpf('8.8.8.8', 'user@sf.com', 'ehlo.host', resolver);
		expect(result.result).toBe('softfail');
	});

	it('maps ?all to neutral', async () => {
		const resolver = resolverFrom({ 'nu.com': 'v=spf1 ?all' });
		const result = await checkSpf('8.8.8.8', 'user@nu.com', 'ehlo.host', resolver);
		expect(result.result).toBe('neutral');
	});
});
