/**
 * Branch coverage for the `mx` / bare-`a` mechanisms and the top-level DNS-error
 * handling in `spf.ts` that the frozen `spfBudget.test.ts` (which exercises only
 * `a:host` targets) does not reach: an `mx` match through a resolved MX host's A
 * record (both object and bare-string MX forms), a bare `a` match against the
 * record domain, and the outer TXT-lookup catch (SERVFAIL → temperror,
 * NXDOMAIN → none, empty/non-SPF TXT → none). The resolver is injected.
 */

import { describe, it, expect } from 'vitest';
import { checkSpf, type SpfDnsResolver } from '../spf.js';

const notFound = (): never => {
	throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
};

describe('checkSpf — mx / a mechanisms', () => {
	it('passes when a resolved MX host A record matches the sender (object MX form)', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT') {
				if (name === 'mxpass.com') return [['v=spf1 mx -all']] as unknown[];
				return notFound();
			}
			if (type === 'MX') {
				if (name === 'mxpass.com') return [{ exchange: 'mail.mxpass.com', priority: 10 }];
				return [] as unknown[];
			}
			if (type === 'A') {
				if (name === 'mail.mxpass.com') return ['1.2.3.4'];
				return [] as unknown[];
			}
			return [] as unknown[];
		};
		const result = await checkSpf('1.2.3.4', 'user@mxpass.com', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('passes when the MX answer is a bare hostname string', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT') {
				if (name === 'strmx.com') return [['v=spf1 mx:relay.com -all']] as unknown[];
				return notFound();
			}
			if (type === 'MX') {
				if (name === 'relay.com') return ['mail.relay.com'];
				return [] as unknown[];
			}
			if (type === 'A') {
				if (name === 'mail.relay.com') return ['5.6.7.8'];
				return [] as unknown[];
			}
			return [] as unknown[];
		};
		const result = await checkSpf('5.6.7.8', 'user@strmx.com', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('passes on a bare `a` mechanism matching the record domain', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT') {
				if (name === 'apass.com') return [['v=spf1 a -all']] as unknown[];
				return notFound();
			}
			if (type === 'A') {
				if (name === 'apass.com') return ['9.8.7.6'];
				return [] as unknown[];
			}
			return [] as unknown[];
		};
		const result = await checkSpf('9.8.7.6', 'user@apass.com', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});
});

describe('checkSpf — top-level lookup outcomes', () => {
	it('returns none when the MAIL FROM has no domain', async () => {
		const resolver: SpfDnsResolver = async () => [] as unknown[];
		const result = await checkSpf('1.2.3.4', 'no-domain-here', 'ehlo.host', resolver);
		expect(result.result).toBe('none');
	});

	it('maps a transient TXT lookup error to temperror', async () => {
		const resolver: SpfDnsResolver = async () => {
			throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
		};
		const result = await checkSpf('1.2.3.4', 'user@flaky.com', 'ehlo.host', resolver);
		expect(result.result).toBe('temperror');
	});

	it('maps a top-level NXDOMAIN to none', async () => {
		const resolver: SpfDnsResolver = async () => notFound();
		const result = await checkSpf('1.2.3.4', 'user@gone.com', 'ehlo.host', resolver);
		expect(result.result).toBe('none');
	});

	it('returns none when the domain publishes no v=spf1 record', async () => {
		const resolver: SpfDnsResolver = async (_name, type) => {
			if (type === 'TXT') return [['google-site-verification=xyz']] as unknown[];
			return [] as unknown[];
		};
		const result = await checkSpf('1.2.3.4', 'user@nospf.com', 'ehlo.host', resolver);
		expect(result.result).toBe('none');
	});
});
