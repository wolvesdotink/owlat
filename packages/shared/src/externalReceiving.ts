/**
 * External receiving — "Owlat sends for this domain, my existing provider keeps
 * receiving it".
 *
 * The provider table for a SEND-ONLY sending domain, shared between the Convex
 * record generator (`domains/providers/mta/index.ts`, `domains/lifecycle.ts`)
 * and the web domain panel, so both answer "which MX belongs to whom" and
 * "which SPF term does that provider need" from ONE table. A second copy in the
 * UI is how a domain gets told to publish an apex SPF record that omits the
 * include its real mail provider needs — silently breaking SPF for everything
 * the customer still sends from Gmail.
 *
 * Why this exists at all: the default sending-domain setup hands the operator an
 * apex `MX 10 mail.<instance>` plus MTA-STS records. For a domain whose mail
 * lives on Google Workspace or Microsoft 365 that guidance is destructive — the
 * MX takes ALL inbound mail away from the existing provider, and an `enforce`
 * MTA-STS policy pins senders to our MX and blackholes the rest. Marking the
 * domain external is what suppresses that guidance; this module is the data it
 * is suppressed in favour of.
 *
 * All pure (no DNS, no Convex): the one function that needs a live MX lookup
 * takes the resolver injected, exactly like `domains/reverseDns.ts`.
 *
 * The table itself and the MX classifier are MODULE-PRIVATE on purpose. Callers
 * want an answer, not the table: the backend wants a finished SPF record
 * ({@link mergeExternalReceivingSpf}) or a finished verdict
 * ({@link inspectExternalReceivingMx}). The web panel reads exactly two of
 * these — {@link externalReceivingSpfMerged}, because the claim "SPF is already
 * merged" has to come from the STORED RECORD rather than from the declared
 * provider, and {@link externalReceivingSpfInclude} to name the term when it
 * did not.
 */

import { mergeSpfRecords } from './spf';

/**
 * Who accepts inbound mail for a sending domain.
 *
 * ABSENCE IS `'owlat'`. Every row that predates this feature has no stored
 * mode, and must behave byte-identically to the day before it shipped — so the
 * default lives here rather than in a backfill, and callers resolve
 * `mode ?? 'owlat'`.
 */
export const DOMAIN_RECEIVING_MODES = ['owlat', 'external'] as const;
export type DomainReceivingMode = (typeof DOMAIN_RECEIVING_MODES)[number];

/**
 * The mail providers we can recognise and generate correct SPF for.
 *
 * Both vocabularies are `as const` ARRAYS rather than hand-written unions
 * because the Convex validators that gate these two columns derive from them
 * (`lib/convexValidators.ts` → `literalUnion`). A second spelling on the backend
 * is how an argument the schema rejects gets accepted at the edge and blows up
 * on the insert instead of at the boundary — and a third in the web composable
 * is how the form offers a provider the backend has never heard of.
 */
export const EXTERNAL_RECEIVING_PROVIDER_IDS = ['google', 'microsoft', 'other'] as const;
export type ExternalReceivingProvider = (typeof EXTERNAL_RECEIVING_PROVIDER_IDS)[number];

interface ExternalReceivingProviderInfo {
	readonly id: ExternalReceivingProvider;
	/**
	 * SPF term to fold into the generated apex record, WITHOUT the `include:`
	 * prefix. Absent for `'other'`: we do not know what an unrecognised provider
	 * needs authorized, and guessing would publish a record that fails for their
	 * real sending hosts. The UI carries the "merge this with your existing
	 * record yourself" warning instead.
	 */
	readonly spfInclude?: string;
	/**
	 * MX host suffixes that identify this provider in a live lookup. Matched on a
	 * DOT BOUNDARY (`host === suffix || host.endsWith('.' + suffix)`), never as a
	 * bare substring — a plain `endsWith('google.com')` also matches
	 * `mx.notgoogle.com`, which would report an attacker-chosen domain as
	 * Google-hosted on the operator's setup screen.
	 */
	readonly mxSuffixes: readonly string[];
}

const EXTERNAL_RECEIVING_PROVIDERS: Record<
	ExternalReceivingProvider,
	ExternalReceivingProviderInfo
> = {
	google: {
		id: 'google',
		spfInclude: '_spf.google.com',
		// Workspace hands out `aspmx.l.google.com` + `alt<N>.aspmx.l.google.com`,
		// the older tenants `aspmx<N>.googlemail.com`, and the 2023+ simplified
		// setup a single `smtp.google.com`. All three are covered by the two
		// registrable suffixes.
		mxSuffixes: ['google.com', 'googlemail.com'],
	},
	microsoft: {
		id: 'microsoft',
		spfInclude: 'spf.protection.outlook.com',
		// Microsoft 365 publishes `<tenant>.mail.protection.outlook.com`;
		// `outlook.com` additionally covers the legacy `<tenant>.mail.eo.outlook.com`
		// shape some tenants still carry.
		mxSuffixes: ['protection.outlook.com', 'outlook.com'],
	},
	other: {
		id: 'other',
		mxSuffixes: [],
	},
};

/**
 * The `include:` target for a provider, or `undefined` when we have none
 * (`'other'`, or no declared provider at all).
 *
 * Public because the UI has to NAME the term when the stored record turns out
 * not to carry it — "add something to your SPF record" is not an instruction
 * anyone can follow. It is the one piece of the table the web bundle reads, and
 * it reads it beside {@link externalReceivingSpfMerged}, which already brings
 * this module into that bundle.
 */
export function externalReceivingSpfInclude(
	provider: ExternalReceivingProvider | undefined
): string | undefined {
	return provider ? EXTERNAL_RECEIVING_PROVIDERS[provider].spfInclude : undefined;
}

/**
 * DNS answers carry a trailing root dot and arbitrary case; comparisons and
 * suffix matching below are on this normalized form only.
 */
function normalizeMxHost(host: string): string {
	return host.trim().replace(/\.$/, '').toLowerCase();
}

function matchesSuffix(host: string, suffix: string): boolean {
	return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Which provider does this live MX host set belong to?
 *
 * Returns `null` for "none we recognise" — deliberately NOT `'other'`, which is
 * an operator's DECLARATION about a domain, not something a lookup can observe.
 * Conflating the two would let a failed detection silently overwrite the
 * operator's stated provider.
 */
function detectExternalReceivingProvider(
	mxHosts: readonly string[]
): ExternalReceivingProvider | null {
	const hosts = mxHosts.map(normalizeMxHost).filter(Boolean);
	for (const info of [
		EXTERNAL_RECEIVING_PROVIDERS.google,
		EXTERNAL_RECEIVING_PROVIDERS.microsoft,
	]) {
		if (hosts.some((host) => info.mxSuffixes.some((suffix) => matchesSuffix(host, suffix)))) {
			return info.id;
		}
	}
	return null;
}

/**
 * Fold the external receiver's SPF term into OUR generated apex record.
 *
 * RFC 7208 §3.2 allows exactly one `v=spf1` record per host, so a send-only
 * domain cannot publish ours beside Google's — the apex record has to authorize
 * BOTH or one of the two senders starts failing SPF. `ourRecord` is the base
 * (it already carries the operator's configured trailing qualifier, and
 * `mergeSpfRecords` splices additions in before that qualifier and preserves
 * it), so switching a domain's provider never changes the `~all`/`-all` the
 * operator chose.
 *
 * Idempotent, and a no-op for `'other'`/absent — there is no include to add, so
 * the record is returned unchanged and the UI owns the "merge with your existing
 * record" instruction.
 */
export function mergeExternalReceivingSpf(
	ourRecord: string,
	provider: ExternalReceivingProvider | undefined
): string {
	const include = externalReceivingSpfInclude(provider);
	if (!include) return ourRecord;
	return mergeSpfRecords(ourRecord, `v=spf1 include:${include}`);
}

/**
 * Does this STORED apex record already authorize the external receiver?
 *
 * The question the domain panel has to answer before it tells an operator "SPF
 * is already merged, publish it exactly as shown". Answering it from the
 * declared provider alone is wrong in three real configurations, and wrong in
 * the direction that breaks mail:
 *   - a relay-primary domain (SES/Mandrill) switched to external AFTER
 *     registration — the lifecycle deliberately leaves that provider's record
 *     alone rather than rebuilding it from our own include, so nothing merged;
 *   - a domain switched while `MTA_SPF_INCLUDE` is unset — the lifecycle has no
 *     record to rebuild from and leaves the stored one untouched;
 *   - a row with no `spf` record at all, where "the SPF record above" points at
 *     nothing.
 * So the claim is derived from the RECORD, and this is the derivation.
 *
 * Term-exact matching on whitespace boundaries, not a substring test:
 * `include:_spf.google.com.evil.example` contains `include:_spf.google.com` and
 * would otherwise be read as a merged record.
 *
 * `'other'`/absent is always `false` — there is no include to look for, so the
 * honest answer is "we did not merge anything", which is exactly the case the
 * manual-merge instruction exists for.
 */
export function externalReceivingSpfMerged(
	spfValue: string | undefined | null,
	provider: ExternalReceivingProvider | undefined
): boolean {
	const include = externalReceivingSpfInclude(provider);
	if (!include || !spfValue) return false;
	const term = `include:${include}`.toLowerCase();
	return spfValue.trim().toLowerCase().split(/\s+/).includes(term);
}

/** Structured verdict for the external-receiving MX preflight. Never throws. */
export type ExternalReceivingMxCheck = {
	/** True when the apex resolved to at least one MX host. */
	hasMx: boolean;
	/** The MX hosts found, normalized. Empty on any lookup failure. */
	hosts: string[];
	/** The recognised provider, or `null` when the set matches none of them. */
	provider: ExternalReceivingProvider | null;
	/**
	 * THE LOUD ONE: the apex MX points at this deployment's own mail host. The
	 * domain says its receiving stays external, but the operator published our MX
	 * anyway — so inbound mail has already been taken away from their real
	 * provider. Silence here is what turns that into "mail just stopped arriving".
	 */
	pointsHere: boolean;
};

/** Injected resolver so the classification is unit-testable without real DNS. */
export type ExternalReceivingMxDeps = {
	resolveMx: (hostname: string) => Promise<readonly { exchange: string }[]>;
};

/**
 * Read a domain's apex MX and classify it against the provider table plus this
 * deployment's own mail host.
 *
 * FAIL-SOFT, like `checkReverseDns`: NXDOMAIN, SERVFAIL and a dead resolver are
 * all folded into "no MX found" rather than rejected. This backs a hint on the
 * domain panel; a resolver hiccup must degrade the hint, never break the screen
 * the operator is using to fix their DNS.
 */
export async function inspectExternalReceivingMx(
	domain: string,
	selfMailHost: string | null | undefined,
	deps: ExternalReceivingMxDeps
): Promise<ExternalReceivingMxCheck> {
	const hosts: string[] = [];
	try {
		for (const record of await deps.resolveMx(domain)) {
			const host = normalizeMxHost(record.exchange);
			if (host) hosts.push(host);
		}
	} catch {
		// Swallowed on purpose — see the fail-soft note above.
	}
	const self = selfMailHost ? normalizeMxHost(selfMailHost) : '';
	return {
		hasMx: hosts.length > 0,
		hosts,
		provider: detectExternalReceivingProvider(hosts),
		pointsHere: self !== '' && hosts.includes(self),
	};
}
