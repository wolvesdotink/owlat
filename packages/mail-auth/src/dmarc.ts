/**
 * Inbound DMARC evaluation — RFC 7489.
 *
 * Moved verbatim (logic frozen — a move, not a rewrite) out of the MTA's
 * `apps/mta/src/bounce/inboundDmarc.ts`. Two dependencies on MTA internals were
 * decoupled so the package stands alone: the `logger` is now an OPTIONAL
 * injected `DmarcLogger` (default no-op; the MTA passes its logger to preserve
 * the transient-failure warn), and the SPF/DKIM verdict keywords are defined
 * here (mail-auth owns SPF, and the DKIM verifier lands in a later package
 * piece). The alignment predicate stays in `@owlat/shared/spfAlignment` so the
 * SPF and DKIM sides never fork on the Organizational-Domain heuristic.
 *
 * SPF and DKIM each authenticate *some* domain (the envelope MAIL FROM for
 * SPF, the `d=` tag for DKIM). Neither, on its own, says anything about the
 * domain the human reader sees — the RFC5322.From. DMARC closes that gap: it
 * (a) looks up the From-domain's `_dmarc` policy, (b) checks whether a passing
 * SPF or DKIM result is *aligned* with the From domain, and (c) when neither
 * is aligned, applies the domain owner's published disposition
 * (`none` / `quarantine` / `reject`).
 *
 * Alignment (RFC 7489 §3.1):
 *   - strict  (`aspf=s` / `adkim=s`): the authenticated domain must equal the
 *     From domain exactly.
 *   - relaxed (default): the authenticated domain's Organizational Domain must
 *     equal the From domain's Organizational Domain — i.e. a subdomain is
 *     aligned with its parent.
 */

import { isSpfAligned, organizationalDomain, type AlignmentMode } from '@owlat/shared/spfAlignment';
import type { SpfVerdict } from './spf.js';

/**
 * RFC 8601 DKIM result keyword. Defined here (rather than imported from the
 * MTA's `inboundDkim`) so DMARC has no dependency on the DKIM verifier; the
 * in-house verifier package reuses this same union when it lands.
 */
export type DkimVerdict = 'pass' | 'fail' | 'neutral' | 'none' | 'temperror' | 'permerror';

/** The DMARC policy keyword published in the `p=`/`sp=` tag (RFC 7489 §6.3). */
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

/** RFC 8601 DMARC result keyword we record on the message. */
export type DmarcVerdict = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';

/**
 * The subset of a structured logger DMARC needs. Injected so the package does
 * not depend on the MTA's logger; a default no-op is used when none is passed.
 */
export interface DmarcLogger {
	warn(obj: object, msg: string): void;
}

/** An authenticated-identity input to DMARC: a verdict + the domain it authenticated. */
export interface AuthenticatedIdentity<V extends string> {
	/** The SPF / DKIM result keyword. */
	readonly result: V;
	/** The domain the result authenticated (SPF: MAIL FROM domain; DKIM: `d=`). */
	readonly domain?: string;
}

/** DKIM identities supplied to DMARC, including every passing signature. */
export interface DkimAuthenticatedIdentity extends AuthenticatedIdentity<DkimVerdict> {
	/**
	 * All passing DKIM `d=` domains. DMARC succeeds when any one aligns; `domain`
	 * remains the message-level verifier's representative result for RFC 8601
	 * storage and backwards compatibility.
	 */
	readonly passingDomains?: readonly string[];
}

/**
 * Resolve the From-domain's `_dmarc` TXT record body (the part after
 * `_dmarc.`), e.g. `v=DMARC1; p=reject; sp=quarantine; adkim=s`.
 *
 * Returns:
 *   - the record string when a DMARC record is published,
 *   - `null` when there is definitively no record (NXDOMAIN / NODATA), and
 *   - throws on a transient DNS error so the caller maps it to `temperror`.
 *
 * Injected so tests stay hermetic and so the MTA can supply a budgeted,
 * cached resolver.
 */
export type DmarcPolicyLookup = (domain: string) => Promise<string | null>;

export interface EvaluateDmarcArgs {
	/** The RFC5322.From domain (the domain DMARC authenticates against). */
	readonly fromDomain: string;
	/** SPF verdict + the envelope MAIL FROM domain it authenticated. */
	readonly spf: AuthenticatedIdentity<SpfVerdict>;
	/** DKIM verdict + every passing `d=` domain it authenticated. */
	readonly dkim: DkimAuthenticatedIdentity;
	/** Resolves a domain's `_dmarc` record (see DmarcPolicyLookup). */
	readonly policyLookup: DmarcPolicyLookup;
	/** Optional structured logger for the transient-failure warn. */
	readonly logger?: DmarcLogger;
	/**
	 * RFC 7489 §6.6.1: set when the message carries MULTIPLE `From:` header
	 * fields, or a single `From:` with MORE THAN ONE mailbox address. There is
	 * then no single RFC5322.From identifier to bind a policy to, so DMARC cannot
	 * pass — the evaluator reports `permerror`. The caller (which parses the
	 * headers) detects the ambiguity and passes this flag; `fromDomain` should be
	 * the first/any address's domain and is otherwise unused when this is set.
	 */
	readonly fromAmbiguous?: boolean;
}

export interface DmarcOutcome {
	/** RFC 8601 DMARC result keyword. */
	readonly result: DmarcVerdict;
	/**
	 * The applicable published policy (`p=`, or `sp=` when the From domain is a
	 * subdomain of the policy domain). Present whenever a DMARC record was
	 * found — including on `pass`, so callers can see what *would* have applied.
	 */
	readonly policy?: DmarcPolicy;
	/** Whether a passing SPF result was aligned with the From domain. */
	readonly spfAligned?: boolean;
	/** Whether a passing DKIM result was aligned with the From domain. */
	readonly dkimAligned?: boolean;
}

/** Parsed DMARC record tags we honour. */
interface DmarcRecord {
	readonly p: DmarcPolicy;
	readonly sp?: DmarcPolicy;
	/** `adkim` alignment mode — strict (`s`) or relaxed (`r`, default). */
	readonly adkim: 'r' | 's';
	/** `aspf` alignment mode — strict (`s`) or relaxed (`r`, default). */
	readonly aspf: 'r' | 's';
}

/**
 * Evaluate DMARC for an inbound message (RFC 7489 §6.6.2).
 *
 * Never throws: a policy-lookup crash is logged and reported as `temperror`
 * (the SMTP transaction is still ACK-ed).
 */
export async function evaluateDmarc(args: EvaluateDmarcArgs): Promise<DmarcOutcome> {
	const { spf, dkim, policyLookup } = args;

	if (args.fromAmbiguous) {
		// RFC 7489 §6.6.1: multiple From header fields (or multiple mailbox
		// addresses in one From) give the evaluator no single identifier to bind a
		// policy to — DMARC MUST NOT pass. Report a permanent evaluation failure.
		return { result: 'permerror' };
	}

	const fromDomain = normalizeDomain(args.fromDomain);

	if (!fromDomain) {
		// No parseable From domain → DMARC cannot be evaluated (RFC 7489 §6.6.1
		// treats a missing/multi-valued From as a permanent failure for the
		// evaluator; we record `none` since there is no identifier to bind to).
		return { result: 'none' };
	}

	// 1. Locate the policy. Try the exact From domain first; if it has no record,
	//    fall back to its Organizational Domain (RFC 7489 §6.6.3) and apply `sp=`.
	let record: DmarcRecord | null;
	let policyAppliesToSubdomain = false;
	try {
		record = parseRecord(await policyLookup(fromDomain));
		if (!record) {
			const orgDomain = organizationalDomain(fromDomain);
			if (orgDomain !== fromDomain) {
				record = parseRecord(await policyLookup(orgDomain));
				policyAppliesToSubdomain = record != null;
			}
		}
	} catch (err) {
		args.logger?.warn(
			{ err, fromDomain },
			'Inbound DMARC policy lookup failed — recording temperror'
		);
		return { result: 'temperror' };
	}

	// 2. No DMARC record published anywhere → result is `none` (RFC 7489 §6.6.3).
	if (!record) {
		return { result: 'none' };
	}

	// The policy that applies to *this* message: `sp=` governs subdomains when
	// the record was found on the Organizational Domain (RFC 7489 §6.3).
	const policy: DmarcPolicy = policyAppliesToSubdomain && record.sp ? record.sp : record.p;

	// 3. Alignment. DMARC passes iff a *passing* SPF or DKIM is aligned with the
	//    From domain (RFC 7489 §4.1 / §6.6.2). A failed/absent SPF or DKIM
	//    contributes nothing, but does NOT itself fail DMARC — this is why a
	//    forwarded message with envelope-SPF=fail still passes on aligned DKIM.
	//
	//    `isSpfAligned` is the shared RFC 7489 §3.1 alignment predicate (any two
	//    domains, relaxed/strict) — reused for the DKIM `d=` side too so both
	//    halves agree on the Organizational-Domain heuristic.
	const spfAligned =
		spf.result === 'pass' &&
		!!spf.domain &&
		isSpfAligned(spf.domain, fromDomain, alignmentMode(record.aspf));
	const passingDkimDomains =
		dkim.passingDomains ?? (dkim.domain !== undefined ? [dkim.domain] : []);
	const dkimAligned =
		dkim.result === 'pass' &&
		passingDkimDomains.some((domain) =>
			isSpfAligned(domain, fromDomain, alignmentMode(record.adkim))
		);

	if (spfAligned || dkimAligned) {
		return { result: 'pass', policy, spfAligned, dkimAligned };
	}

	return { result: 'fail', policy, spfAligned, dkimAligned };
}

/** Map a DMARC `aspf`/`adkim` tag to the shared alignment-mode keyword. */
function alignmentMode(tag: 'r' | 's'): AlignmentMode {
	return tag === 's' ? 'strict' : 'relaxed';
}

/** Lowercase + strip a trailing dot from a domain; '' for nullish/blank. */
function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Parse a `_dmarc` TXT record body into the tags we honour. Returns `null`
 * when the input is absent or is not a DMARC record (`v=DMARC1`).
 */
function parseRecord(raw: string | null): DmarcRecord | null {
	if (!raw) return null;
	const tags = new Map<string, string>();
	for (const part of raw.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim().toLowerCase();
		const value = part.slice(eq + 1).trim();
		if (key) tags.set(key, value);
	}

	// A valid DMARC record must start with `v=DMARC1` and carry a `p=` tag
	// (RFC 7489 §6.3 — a record missing a recognised `p` is ignored).
	if ((tags.get('v') ?? '').toUpperCase() !== 'DMARC1') return null;
	const p = parsePolicy(tags.get('p'));
	if (!p) return null;

	return {
		p,
		sp: parsePolicy(tags.get('sp')),
		adkim: tags.get('adkim')?.toLowerCase() === 's' ? 's' : 'r',
		aspf: tags.get('aspf')?.toLowerCase() === 's' ? 's' : 'r',
	};
}

function parsePolicy(value: string | undefined): DmarcPolicy | undefined {
	switch ((value ?? '').toLowerCase()) {
		case 'none':
			return 'none';
		case 'quarantine':
			return 'quarantine';
		case 'reject':
			return 'reject';
		default:
			return undefined;
	}
}

/**
 * A `DmarcPolicyLookup` backed by `dns.resolveTxt`, fetching `_dmarc.<domain>`
 * and joining the concatenated TXT strings. NXDOMAIN/NODATA → `null`; any other
 * DNS error is re-thrown so `evaluateDmarc` maps it to `temperror`.
 *
 * Lives here (not used by the tests, which inject their own lookup) so the MTA
 * has a ready production resolver.
 */
export async function dnsDmarcLookup(
	domain: string,
	resolveTxt: (name: string) => Promise<string[][]>
): Promise<string | null> {
	let records: string[][];
	try {
		records = await resolveTxt(`_dmarc.${normalizeDomain(domain)}`);
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOTFOUND' || code === 'ENODATA') return null;
		throw err;
	}
	const joined = records
		.map((chunks) => chunks.join(''))
		.find((r) => r.toLowerCase().startsWith('v=dmarc1'));
	return joined ?? null;
}
