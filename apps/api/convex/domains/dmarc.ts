/**
 * DMARC policy — shared shape + record builder for the **Sending domain**
 * provider adapters and the lifecycle's `setDmarcPolicy` entry point.
 *
 * A sending domain always starts in monitor-only mode (`p=none`) so the
 * customer can collect aggregate reports without risking legitimate mail.
 * Once they trust the alignment they raise the policy to `quarantine` or
 * `reject` to actually enforce DMARC — that's the whole point of DMARC, and
 * the policy is stored on the `domains` row (`domains.dmarcPolicy`).
 *
 * Beyond the headline `p=` policy, RFC 7489 §6.3 defines several enforcement
 * knobs operators need for a safe rollout:
 *   - `sp=`    subdomain policy. A domain at `p=reject` *implicitly* rejects
 *              all subdomains (default `sp=p`), which is rarely what you want
 *              mid-rollout — `sp=none` lets the apex enforce while subdomains
 *              stay in monitor-only.
 *   - `pct=`   the percentage of mail the policy is applied to, for a staged
 *              rollout (`pct=10` → enforce on 10%, monitor the rest).
 *   - `adkim=` / `aspf=`  DKIM / SPF alignment strictness (`r` relaxed,
 *              `s` strict).
 *   - `rua=`   aggregate-report reporting URI.
 *
 * Both provider adapters generate the initial `_dmarc` TXT record with
 * `buildDmarcRecordValue` so the wire shape can't drift, and the lifecycle's
 * `setDmarcPolicy` regenerates the same record when the customer raises the
 * policy. The DNS verifier compares the customer-published record against the
 * stored `dnsRecords.dmarc.value`, so raising the policy and re-publishing the
 * matching record verifies cleanly.
 */

import { v } from 'convex/values';

export const DMARC_POLICIES = ['none', 'quarantine', 'reject'] as const;

export type DmarcPolicy = (typeof DMARC_POLICIES)[number];

/** DMARC alignment modes (RFC 7489 §6.3): `r` relaxed, `s` strict. */
export const DMARC_ALIGNMENTS = ['r', 's'] as const;

export type DmarcAlignment = (typeof DMARC_ALIGNMENTS)[number];

/** New domains start in monitor-only mode. */
export const DEFAULT_DMARC_POLICY: DmarcPolicy = 'none';

export const dmarcPolicyValidator = v.union(
	v.literal('none'),
	v.literal('quarantine'),
	v.literal('reject'),
);

export const dmarcAlignmentValidator = v.union(v.literal('r'), v.literal('s'));

export function isDmarcPolicy(value: string | undefined | null): value is DmarcPolicy {
	return value === 'none' || value === 'quarantine' || value === 'reject';
}

export function isDmarcAlignment(value: string | undefined | null): value is DmarcAlignment {
	return value === 'r' || value === 's';
}

/**
 * Options for {@link buildDmarcRecordValue}. `policy` is the only required
 * field; the rest are RFC 7489 §6.3 enforcement knobs that are emitted only
 * when set (so a monitor-only domain still renders the minimal
 * `v=DMARC1; p=none`).
 */
export interface DmarcRecordOptions {
	/** Headline policy — the `p=` tag. */
	policy: DmarcPolicy;
	/** Subdomain policy — the `sp=` tag. Omitted ⇒ DMARC's default `sp=p`. */
	subdomainPolicy?: DmarcPolicy;
	/** Staged-rollout percentage 0–100 — the `pct=` tag. */
	pct?: number;
	/** DKIM alignment strictness — the `adkim=` tag. */
	adkim?: DmarcAlignment;
	/** SPF alignment strictness — the `aspf=` tag. */
	aspf?: DmarcAlignment;
	/**
	 * Aggregate-report reporting URI — the `rua=` tag. Owlat does not provision
	 * a `dmarc@<customer-domain>` mailbox, so this is emitted only when the
	 * operator opts in (the `MTA_DMARC_RUA` env var, threaded in by the provider
	 * adapters and the lifecycle). Emitted verbatim and expected to be an
	 * RFC-7489 reporting URI such as `mailto:dmarc-reports@example.com`.
	 */
	rua?: string;
}

/**
 * Build the `_dmarc` TXT record value for a domain at a given policy.
 *
 * Tags are emitted in RFC 7489 §6.3 canonical order:
 * `v; p; sp; pct; adkim; aspf; rua`. Only `v=DMARC1` and `p=` are always
 * present; every other tag is emitted only when its option is set, so a
 * monitor-only domain renders the minimal `v=DMARC1; p=none`.
 *
 * @throws if `pct` is supplied outside the 0–100 range (RFC 7489 requires an
 * integer percentage), since publishing an out-of-range `pct=` produces a DMARC
 * record receivers will ignore.
 */
export function buildDmarcRecordValue(domain: string, options: DmarcRecordOptions): string {
	const parts = [`v=DMARC1`, `p=${options.policy}`];

	if (options.subdomainPolicy !== undefined) {
		parts.push(`sp=${options.subdomainPolicy}`);
	}

	if (options.pct !== undefined) {
		if (!Number.isInteger(options.pct) || options.pct < 0 || options.pct > 100) {
			throw new Error(
				`DMARC pct must be an integer between 0 and 100, got ${options.pct}`,
			);
		}
		parts.push(`pct=${options.pct}`);
	}

	if (options.adkim !== undefined) {
		parts.push(`adkim=${options.adkim}`);
	}

	if (options.aspf !== undefined) {
		parts.push(`aspf=${options.aspf}`);
	}

	const rua = options.rua?.trim();
	if (rua) {
		parts.push(`rua=${rua}`);
	}

	return parts.join('; ');
}
