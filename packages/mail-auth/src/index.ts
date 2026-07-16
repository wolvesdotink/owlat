/**
 * `@owlat/mail-auth` — in-house email authentication.
 *
 * Public surface:
 *   - SPF (RFC 7208): `checkSpf`, `SpfResult`, `SpfVerdict`, `SpfDnsResolver`.
 *   - DMARC (RFC 7489): `evaluateDmarc`, `dnsDmarcLookup`, and the associated
 *     verdict / policy / identity types.
 *   - DNS: an injectable, Redis-cached resolver (`createCachedResolver`,
 *     `toSpfResolver`) with the TTL contract in `dns.ts`.
 */

export { checkSpf } from './spf.js';
export type { SpfResult, SpfVerdict, SpfDnsResolver } from './spf.js';

export { evaluateDmarc, dnsDmarcLookup } from './dmarc.js';
export type {
	DkimVerdict,
	DmarcPolicy,
	DmarcVerdict,
	DmarcLogger,
	AuthenticatedIdentity,
	DmarcPolicyLookup,
	EvaluateDmarcArgs,
	DmarcOutcome,
} from './dmarc.js';

export {
	createCachedResolver,
	toSpfResolver,
	MAX_DNS_TTL_SECONDS,
	NEGATIVE_TTL_SECONDS,
} from './dns.js';
export type {
	DnsRecordType,
	CachedDnsAnswer,
	DnsResolver,
	RedisLike,
	CachedResolverOptions,
} from './dns.js';
