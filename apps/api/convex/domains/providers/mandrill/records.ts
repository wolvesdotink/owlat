/**
 * The DNS an operator publishes to send through Mandrill — a pure function of
 * the domain name.
 *
 * This is THE structural difference from SES, and the reason the Mandrill
 * adapter needs no `dnsRecords` column of its own on the identity row: Mandrill
 * signs every account's mail with ONE shared, account-independent key under the
 * `mandrill` selector, and authorises every account's mail through ONE SPF
 * include. SES mints per-domain DKIM tokens and a per-identity verification
 * token, so its records can only be remembered; Mandrill's can only be derived.
 *
 * Pure and dependency-light on purpose: the domain-setup UI (P3.2) renders the
 * same records from the same helper rather than reading them back out of a row
 * that could disagree with what we actually told Mandrill.
 */

import { buildDmarcRecordValue, DEFAULT_DMARC_POLICY } from '../../dmarc';
import { getOptional } from '../../../lib/env';
import type { DnsRecords } from '../../domains';

/** The selector Mandrill signs with. Account-independent (see module header). */
export const MANDRILL_DKIM_SELECTOR = 'mandrill';

/** The SPF mechanism that authorises Mandrill's outbound IPs. */
export const MANDRILL_SPF_MECHANISM = 'include:spf.mandrillapp.com';

/**
 * Mandrill's published DKIM public key, as its setup documentation states it.
 *
 * A CONSTANT is honest here — every Mandrill account publishes this same record
 * — but it is a third party's key, so treat it as evidence that can go stale:
 * `senders/check-domain` is the AUTHORITY on whether the published record is
 * the one Mandrill wants, and its `dkim.error` text is stored and surfaced
 * verbatim. If Mandrill ever rotates, the identity simply never reaches
 * `verified` and the relay proof stays closed (the safe direction) with
 * Mandrill's own words on screen, rather than mail silently going out unsigned.
 */
export const MANDRILL_DKIM_PUBLIC_KEY =
	'v=DKIM1; k=rsa; h=sha256; ' +
	'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCrLHiExVd55zd/IQ/J/mRwSRMAocV/hMB3jXwaHH36d9NaVynQFYV8N' +
	'aWi69c1veUtRzGt7yAioXqLj7Z4TeEUoOLgrKsn8YnckGs9i3B3tVFB+Ch/4mPhXWiNfNdynHWBcPcbJ8kjEQ2U8y78dHZj' +
	'1YeRXXVvWob2OaKynO8/lQIDAQAB;';

/** The host (zone-relative) the DKIM TXT record is published at. */
export const MANDRILL_DKIM_HOST = `${MANDRILL_DKIM_SELECTOR}._domainkey`;

/**
 * The TXT record that proves domain OWNERSHIP to Mandrill, given the key its
 * API handed us. Zone-relative apex record, exactly as Mandrill documents it.
 *
 * Only ever built from a key Mandrill actually returned — an account whose API
 * does not offer one verifies by mailbox instead, and inventing a token would
 * send the operator to publish a record that can never clear.
 */
export function buildMandrillVerifyRecord(verifyTxtKey: string): {
	type: 'TXT';
	host: string;
	value: string;
} {
	return { type: 'TXT', host: '@', value: `mandrill_verify.${verifyTxtKey}` };
}

/**
 * The full record set for a domain that sends through Mandrill.
 *
 * Shaped exactly like the SES adapter's (SPF at the apex, DKIM, a monitor-only
 * DMARC for a brand-new domain) so the domain-setup UI renders one thing. No
 * `mailFrom` records: Mandrill mints its own bounce local part, so there is no
 * custom MAIL FROM subdomain to publish (plan D5, and the reason the send
 * adapter declines the return-path probe outright).
 */
export function buildMandrillDnsRecords(domain: string): DnsRecords {
	return {
		spf: {
			type: 'TXT',
			host: '@',
			value: `v=spf1 ${MANDRILL_SPF_MECHANISM} -all`,
		},
		dkim: [
			{
				type: 'TXT',
				host: MANDRILL_DKIM_HOST,
				value: MANDRILL_DKIM_PUBLIC_KEY,
			},
		],
		// New domains start in monitor-only mode (`p=none`); the operator raises
		// the policy through `setDmarcPolicy`, same as every other provider.
		dmarc: {
			type: 'TXT',
			host: '_dmarc',
			value: buildDmarcRecordValue(domain, {
				policy: DEFAULT_DMARC_POLICY,
				rua: getOptional('MTA_DMARC_RUA'),
			}),
		},
	};
}
