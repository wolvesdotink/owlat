/**
 * `@owlat/mail-auth` — in-house email authentication.
 *
 * Public surface:
 *   - SPF (RFC 7208): `checkSpf`, `SpfResult`, `SpfVerdict`, `SpfDnsResolver`.
 *   - DMARC (RFC 7489): `evaluateDmarc`, `dnsDmarcLookup`, and the associated
 *     verdict / policy / identity types.
 *   - DNS: an injectable, Redis-cached resolver (`createCachedResolver`,
 *     `toSpfResolver`) with the TTL contract in `dns.ts`.
 *   - Canonicalization (RFC 6376 §3.4): the shared `canon` public API (D4),
 *     consumed by both the DKIM verifier and the outbound signer.
 *   - DKIM (RFC 6376 / 8463 / 8601): `verifyDkim` plus the key-record parser.
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

export {
	canonicalizeBody,
	canonicalizeBodyRelaxed,
	canonicalizeBodySimple,
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
} from './canon.js';
export type { Canonicalization } from './canon.js';

export { verifyDkim } from './dkim/verify.js';
export type {
	DkimDnsResolver,
	DkimSignatureResult,
	DkimVerifyResult,
	VerifyDkimOptions,
} from './dkim/verify.js';

export { isKeyRecordError, parseDkimKeyRecord } from './dkim/keyRecord.js';
export type { DkimKeyRecord, DkimKeyRecordError, ParsedKeyRecord } from './dkim/keyRecord.js';
