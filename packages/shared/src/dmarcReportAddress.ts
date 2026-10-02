/**
 * The address Owlat reads DMARC aggregate (RUA) reports at, shared by the MTA
 * (which routes mail for it to the report webhook instead of any mailbox) and
 * the Convex backend (which writes it into the generated `_dmarc` record and
 * tells the operator what to publish). One resolver, so the address the record
 * asks receivers to use is the address the MTA actually catches.
 *
 * DMARC reporting is mailto-only (RFC 7489 §7.1), so reports arrive as mail.
 * The default address lives on the return-path (bounce) domain: that domain has
 * to reach the built-in MTA for bounces to work, so mail to
 * `dmarc-reports@<return-path domain>` already lands there with no new DNS.
 * `MTA_DMARC_REPORT_ADDRESS` overrides it, and `off` turns the address off.
 *
 * Pure (no DNS, no Convex): the authorization-record helper only needs the
 * Public Suffix List split from `./dnsZone`.
 */

import { trySplitZone } from './dnsZone';

/** Local part of the default report address on the return-path domain. */
export const DEFAULT_DMARC_REPORT_LOCAL_PART = 'dmarc-reports';

/** Value of `MTA_DMARC_REPORT_ADDRESS` that turns Owlat's report address off. */
const DMARC_REPORT_ADDRESS_OFF = 'off';

/**
 * Normalise a configured address (bare or `mailto:` URI, optionally with a
 * `?subject=` style query or an RFC 7489 `!size` limit) to a lowercase
 * `local@domain`. Returns null for anything without a local part and a domain.
 */
export function normalizeDmarcReportAddress(raw: string | undefined | null): string | null {
	const trimmed = raw?.trim().toLowerCase();
	if (!trimmed) return null;
	const withoutScheme = trimmed.startsWith('mailto:') ? trimmed.slice('mailto:'.length) : trimmed;
	const address = withoutScheme.split(/[?!]/)[0]?.trim() ?? '';
	const at = address.lastIndexOf('@');
	if (at < 1 || at === address.length - 1) return null;
	if (/[\s,;<>"]/.test(address)) return null;
	return address;
}

/**
 * The address Owlat reads DMARC reports at, or null when it reads none.
 *
 * - `configured` is `MTA_DMARC_REPORT_ADDRESS`. `off` disables the address; any
 *   other usable value wins over the default.
 * - Otherwise the default is `dmarc-reports@<returnPathDomain>`.
 * - No usable configuration and no return-path domain → null (the install has
 *   no inbound path Owlat can rely on).
 */
export function resolveDmarcReportAddress(
	configured: string | undefined | null,
	returnPathDomain: string | undefined | null
): string | null {
	const raw = configured?.trim();
	if (raw) {
		if (raw.toLowerCase() === DMARC_REPORT_ADDRESS_OFF) return null;
		return normalizeDmarcReportAddress(raw);
	}
	const domain = returnPathDomain?.trim().toLowerCase().replace(/\.$/, '');
	if (!domain) return null;
	return normalizeDmarcReportAddress(`${DEFAULT_DMARC_REPORT_LOCAL_PART}@${domain}`);
}

/** The TXT record a report domain publishes to accept another domain's reports. */
export interface DmarcReportAuthorizationRecord {
	type: 'TXT';
	/** Absolute name: `<policy domain>._report._dmarc.<report domain>`. */
	hostname: string;
	value: 'v=DMARC1';
}

/**
 * The RFC 7489 §7.1 external-destination authorization record, or null when
 * none is needed.
 *
 * A receiver only sends reports to an address outside the policy domain's
 * Organizational Domain if the report domain publishes
 * `<policy domain>._report._dmarc.<report domain>` TXT `v=DMARC1`. Same
 * Organizational Domain (`mail.example.com` reporting to
 * `dmarc-reports@bounces.example.com`) needs nothing.
 */
export function dmarcReportAuthorizationRecord(
	policyDomain: string,
	reportAddress: string
): DmarcReportAuthorizationRecord | null {
	const policy = policyDomain.trim().toLowerCase().replace(/\.$/, '');
	const reportDomain = reportAddress.slice(reportAddress.lastIndexOf('@') + 1).toLowerCase();
	if (!policy || !reportDomain) return null;
	const policyOrg = trySplitZone(policy)?.registrable ?? policy;
	const reportOrg = trySplitZone(reportDomain)?.registrable ?? reportDomain;
	if (policyOrg === reportOrg) return null;
	return {
		type: 'TXT',
		hostname: `${policy}._report._dmarc.${reportDomain}`,
		value: 'v=DMARC1',
	};
}
