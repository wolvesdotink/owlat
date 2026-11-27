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

const servfail = (): never => {
	throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
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

	it('passes an IPv6 sender authorized by the a mechanism through AAAA', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'a6.example') return [['v=spf1 a -all']];
			if (type === 'AAAA' && name === 'a6.example') return ['2001:db8:0:0::5'];
			if (type === 'A') throw new Error('IPv6 a mechanism must not query A');
			return [];
		};
		const result = await checkSpf('2001:db8::5', 'user@a6.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('passes an IPv6 sender authorized by an MX host AAAA record', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'mx6.example') return [['v=spf1 mx -all']];
			if (type === 'MX' && name === 'mx6.example') {
				return [{ exchange: 'mail.mx6.example', priority: 10 }];
			}
			if (type === 'AAAA' && name === 'mail.mx6.example') return ['2001:db8::9'];
			if (type === 'A') throw new Error('IPv6 mx mechanism must not query A');
			return [];
		};
		const result = await checkSpf('2001:db8::9', 'user@mx6.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it.each([
		{
			name: 'a address lookup',
			record: 'v=spf1 a -all',
			failType: 'A' as const,
			failName: 'temp.example',
		},
		{
			name: 'mx lookup',
			record: 'v=spf1 mx -all',
			failType: 'MX' as const,
			failName: 'temp.example',
		},
		{
			name: 'exists lookup',
			record: 'v=spf1 exists:probe.temp.example -all',
			failType: 'A' as const,
			failName: 'probe.temp.example',
		},
	])('maps a transient $name failure to temperror', async ({ record, failType, failName }) => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'temp.example') return [[record]];
			if (type === failType && name === failName) return servfail();
			return [];
		};
		const result = await checkSpf('192.0.2.1', 'user@temp.example', 'ehlo.host', resolver);
		expect(result.result).toBe('temperror');
	});

	it('maps a transient MX host address failure to temperror', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'mx-temp.example') return [['v=spf1 mx -all']];
			if (type === 'MX' && name === 'mx-temp.example') {
				return [{ exchange: 'mail.mx-temp.example', priority: 10 }];
			}
			if (type === 'A' && name === 'mail.mx-temp.example') return servfail();
			return [];
		};
		const result = await checkSpf('192.0.2.1', 'user@mx-temp.example', 'ehlo.host', resolver);
		expect(result.result).toBe('temperror');
	});

	it.each([
		{ record: 'v=spf1 a/24 -all', lookup: 'cidr.example' },
		{ record: 'v=spf1 a:mail.cidr.example/24 -all', lookup: 'mail.cidr.example' },
	])('honors an IPv4 CIDR on $record', async ({ record, lookup }) => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'cidr.example') return [[record]];
			if (type === 'A' && name === lookup) return ['192.0.2.200'];
			return [];
		};
		const result = await checkSpf('192.0.2.1', 'user@cidr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('honors dual CIDR syntax for an IPv6 a mechanism', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'cidr6.example') return [['v=spf1 a//64 -all']];
			if (type === 'AAAA' && name === 'cidr6.example') return ['2001:db8:abcd::1'];
			return [];
		};
		const result = await checkSpf(
			'2001:db8:abcd::ffff',
			'user@cidr6.example',
			'ehlo.host',
			resolver
		);
		expect(result.result).toBe('pass');
	});

	it('honors an IPv4 CIDR on an mx mechanism', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'mxcidr.example') return [['v=spf1 mx/24 -all']];
			if (type === 'MX' && name === 'mxcidr.example') {
				return [{ exchange: 'mail.mxcidr.example', priority: 10 }];
			}
			if (type === 'A' && name === 'mail.mxcidr.example') return ['198.51.100.200'];
			return [];
		};
		const result = await checkSpf('198.51.100.1', 'user@mxcidr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('permerrors an out-of-range ip4 prefix instead of authenticating it', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'badcidr.example') {
				return [['v=spf1 ip4:0.0.0.0/33 -all']];
			}
			return [];
		};
		const result = await checkSpf('1.2.3.4', 'user@badcidr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('permerror');
	});

	it('expands a reversed-IP transformer in an exists mechanism', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'macro-transform.example') {
				return [['v=spf1 exists:%{ir}.auth.example -all']];
			}
			if (type === 'A' && name === '4.3.2.1.auth.example') return ['127.0.0.2'];
			return [];
		};
		const result = await checkSpf('1.2.3.4', 'user@macro-transform.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('evaluates the HELO identity when MAIL FROM is null', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'helo.example') {
				return [['v=spf1 ip4:203.0.113.10 -all']];
			}
			return [];
		};
		const result = await checkSpf('203.0.113.10', '', 'helo.example', resolver);
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

describe('checkSpf — RFC 7208 §4.5 record selection', () => {
	it('joins all character-strings in one TXT RR before evaluating it', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'split.com') {
				return [['v=spf1 ip4:', '1.2.3.4', ' -all']] as unknown[];
			}
			return notFound();
		};
		const result = await checkSpf('1.2.3.4', 'user@split.com', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('joins split TXT character-strings for include and redirect targets', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type !== 'TXT') return [];
			if (name === 'include-source.com') {
				return [['v=spf1 include:split-policy.com -all']] as unknown[];
			}
			if (name === 'redirect-source.com') {
				return [['v=spf1 redirect=split-policy.com']] as unknown[];
			}
			if (name === 'split-policy.com') {
				return [['v=spf1 ip4:', '1.2.3.4', ' -all']] as unknown[];
			}
			return notFound();
		};

		await expect(
			checkSpf('1.2.3.4', 'user@include-source.com', 'ehlo.host', resolver)
		).resolves.toMatchObject({ result: 'pass' });
		await expect(
			checkSpf('1.2.3.4', 'user@redirect-source.com', 'ehlo.host', resolver)
		).resolves.toMatchObject({ result: 'pass' });
	});

	it('returns permerror when more than one v=spf1 record is published', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'dup.com') {
				return [['v=spf1 ip4:1.2.3.4 -all'], ['v=spf1 include:other.com -all']] as unknown[];
			}
			return notFound();
		};
		const result = await checkSpf('1.2.3.4', 'user@dup.com', 'ehlo.host', resolver);
		expect(result.result).toBe('permerror');
	});

	it('recognizes a bare, mechanism-less `v=spf1` record (not "no record")', async () => {
		// The trailing-space prefix bug read a record with no terms as absent → none.
		// A bare `v=spf1` is a valid record; with no mechanism it yields neutral.
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'bare.com') return [['v=spf1']] as unknown[];
			return notFound();
		};
		const result = await checkSpf('1.2.3.4', 'user@bare.com', 'ehlo.host', resolver);
		expect(result.result).not.toBe('none');
		expect(result.result).toBe('neutral');
	});
});

describe('checkSpf — a:/mx: macro expansion (RFC 7208 §7)', () => {
	it('expands a macro in an `a:` domain-spec (`a:%{d}`) before the A lookup', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'macro.com') {
				return [['v=spf1 a:%{d} -all']] as unknown[];
			}
			// Only the EXPANDED target resolves; a literal `%{d}` would not match.
			if (type === 'A' && name === 'macro.com') return ['1.2.3.4'];
			return [] as unknown[];
		};
		const result = await checkSpf('1.2.3.4', 'user@macro.com', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('expands a macro in an `mx:` domain-spec (`mx:%{d}`) before the MX lookup', async () => {
		const resolver: SpfDnsResolver = async (name, type) => {
			if (type === 'TXT' && name === 'mxmacro.com') {
				return [['v=spf1 mx:%{d} -all']] as unknown[];
			}
			if (type === 'MX' && name === 'mxmacro.com') {
				return [{ exchange: 'mail.mxmacro.com', priority: 10 }];
			}
			if (type === 'A' && name === 'mail.mxmacro.com') return ['5.6.7.8'];
			return [] as unknown[];
		};
		const result = await checkSpf('5.6.7.8', 'user@mxmacro.com', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});
});

describe('checkSpf — ptr mechanism (RFC 7208 §5.5)', () => {
	type Answer = unknown[] | 'servfail';

	/** A resolver over a `"<TYPE> <name>"` table that records every query it answers. */
	function tableResolver(table: Record<string, Answer>): {
		resolver: SpfDnsResolver;
		queries: string[];
	} {
		const queries: string[] = [];
		const resolver: SpfDnsResolver = async (name, type) => {
			const key = `${type} ${name}`;
			queries.push(key);
			const answer = table[key];
			if (answer === 'servfail') return servfail();
			return answer ?? [];
		};
		return { resolver, queries };
	}

	const SENDER_IP = '203.0.113.165';
	const SENDER_PTR = 'PTR 165.113.0.203.in-addr.arpa';

	it('passes a sender that only a forward-confirmed `ptr:domain` authorizes', async () => {
		// The shape of a large provider's record: its own ranges and includes do
		// not cover every outbound server, and `ptr:` vouches for the rest.
		const { resolver } = tableResolver({
			'TXT provider.example': [
				['v=spf1 include:_spf.esp.example ip4:192.0.2.0/24 ptr:mail.provider.example -all'],
			],
			'TXT _spf.esp.example': [['v=spf1 ip4:198.51.100.0/24 -all']],
			[SENDER_PTR]: ['out-0166.east.mail.provider.example.'],
			'A out-0166.east.mail.provider.example': [SENDER_IP],
		});
		const result = await checkSpf(SENDER_IP, 'verify@provider.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('matches a bare `ptr` against the domain of the record being evaluated', async () => {
		const { resolver } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr -all']],
			[SENDER_PTR]: ['MAIL.PTR.EXAMPLE'],
			'A mail.ptr.example': [SENDER_IP],
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('accepts a validated name equal to the target domain', async () => {
		const { resolver } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr:ptr.example -all']],
			[SENDER_PTR]: ['ptr.example'],
			'A ptr.example': [SENDER_IP],
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('does not match a PTR name whose forward lookup does not return the sender', async () => {
		// Anyone who controls the reverse zone of an address can claim any name;
		// only the forward lookup in the claimed domain proves it.
		const { resolver } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr -all']],
			[SENDER_PTR]: ['mail.ptr.example'],
			'A mail.ptr.example': ['192.0.2.7'],
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('fail');
	});

	it('does not match a name that only ends in the target text without a label boundary', async () => {
		const { resolver, queries } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr -all']],
			[SENDER_PTR]: ['mail.notptr.example'],
			'A mail.notptr.example': [SENDER_IP],
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('fail');
		// A name outside the target domain is never worth a forward lookup.
		expect(queries).not.toContain('A mail.notptr.example');
	});

	it('does not match when the sender has no PTR record, and is not a permerror', async () => {
		const { resolver } = tableResolver({ 'TXT ptr.example': [['v=spf1 ptr ~all']] });
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('softfail');
	});

	it('treats a failed PTR lookup as no match rather than a temperror', async () => {
		const { resolver } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr ip4:203.0.113.0/24 -all']],
			[SENDER_PTR]: 'servfail',
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('skips a name whose forward lookup fails and validates the next one', async () => {
		const { resolver } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr -all']],
			[SENDER_PTR]: ['a.ptr.example', 'b.ptr.example'],
			'A a.ptr.example': 'servfail',
			'A b.ptr.example': [SENDER_IP],
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('forward-confirms an IPv6 sender through its ip6.arpa name and AAAA records', async () => {
		const ip6Ptr = 'PTR 5.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa';
		const { resolver } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr -all']],
			[ip6Ptr]: ['mail.ptr.example'],
			'AAAA mail.ptr.example': ['2001:0db8:0000:0000:0000:0000:0000:0025'],
		});
		const result = await checkSpf('2001:db8::25', 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('pass');
	});

	it('forward-checks at most ten PTR names', async () => {
		const names = Array.from({ length: 11 }, (_, i) => `h${i}.ptr.example`);
		const { resolver, queries } = tableResolver({
			'TXT ptr.example': [['v=spf1 ptr -all']],
			[SENDER_PTR]: names,
			// Only the eleventh name would validate, and RFC 7208 §4.6.4 says to
			// ignore every PTR record after the first ten.
			[`A ${names[10]}`]: [SENDER_IP],
		});
		const result = await checkSpf(SENDER_IP, 'user@ptr.example', 'ehlo.host', resolver);
		expect(result.result).toBe('fail');
		expect(queries.filter((query) => query.startsWith('A ')).length).toBe(10);
	});
});
