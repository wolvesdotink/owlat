/**
 * Mandrill's answer for the operator surface — the shared row, plus the two
 * things only this adapter knows.
 *
 * The generic read (`../relayIdentityView.ts`) already reports Mandrill's status
 * and its verbatim SPF/DKIM verdicts, because Mandrill keeps its rows in the
 * shared table like every kind after SES. What it cannot know is:
 *
 *  - the RECORDS. Mandrill signs every account with one shared selector, so the
 *    SPF include and the DKIM key are a pure function of the domain name
 *    (`./records.ts`) rather than something the row remembers. Derived from the
 *    same helper the adapter registers with, so the screen can never show DNS we
 *    did not ask Mandrill about.
 *  - the OWNERSHIP step. A domain with perfect SPF and DKIM but no ownership
 *    proof is one Mandrill still bounces (`reject_reason: unsigned`), and the
 *    token that clears it — when this account's API offers one at all — lives in
 *    the versioned `providerDetails` blob.
 *
 * Read through `parseMandrillProviderDetails`, so a row written by a future
 * version reports "nothing known" instead of being reinterpreted under today's
 * shape.
 */

import { MANDRILL_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../../_generated/server';
import { loadRelayIdentityForDomain } from '../relayIdentityProof';
import { relayIdentityFactsFromRow, type RelayDnsRecordView } from '../relayIdentityView';
import type { RelayDomainIdentityFacts } from '../relayIdentityView';
import { parseMandrillProviderDetails } from './identity';
import { buildMandrillDnsRecords, buildMandrillVerifyRecord } from './records';

/**
 * The records for one domain: the derived pair, plus the ownership TXT only when
 * Mandrill actually handed this account a key.
 *
 * An account without one verifies by mailbox in Mandrill's own dashboard, and
 * inventing a token would send the operator to publish a record that can never
 * clear — the panel says so instead, from its per-kind copy.
 */
function mandrillRecordViews(
	domain: string,
	verifyTxtKey: string | undefined
): RelayDnsRecordView[] {
	const records = buildMandrillDnsRecords(domain);
	const ownership =
		verifyTxtKey === undefined ? undefined : buildMandrillVerifyRecord(verifyTxtKey);
	return [
		...(records.spf
			? [{ label: 'SPF', type: records.spf.type, host: records.spf.host, value: records.spf.value }]
			: []),
		...(records.dkim ?? []).map((record) => ({
			label: 'DKIM',
			...(record.type !== undefined ? { type: record.type } : {}),
			...(record.host !== undefined ? { host: record.host } : {}),
			value: record.value,
		})),
		...(ownership
			? [
					{
						label: 'Ownership',
						type: ownership.type,
						host: ownership.host,
						value: ownership.value,
					},
				]
			: []),
	];
}

/**
 * What Mandrill can say about `domain`, or null when this account holds no
 * identity for it.
 *
 * The freshness bound is reported rather than applied: routing refuses a proof
 * older than {@link MANDRILL_RELAY_PROOF_MAX_AGE_MS}
 * (`./relayVerification.ts`), and handing the surface the same number lets it
 * say "verified, re-checking" the moment routing stops trusting the row — one
 * rule, read twice, instead of two rules that drift.
 */
export async function mandrillRelayIdentityFacts(
	ctx: QueryCtx | MutationCtx,
	domain: Doc<'domains'>
): Promise<RelayDomainIdentityFacts | null> {
	const row = await loadRelayIdentityForDomain(ctx, 'mandrill', domain.domain);
	if (row === null) return null;
	const details = parseMandrillProviderDetails(row.providerDetails, row.providerDetailsVersion);
	return relayIdentityFactsFromRow(row, {
		records: mandrillRecordViews(row.domain, details?.verifyTxtKey),
		proofMaxAgeMs: MANDRILL_RELAY_PROOF_MAX_AGE_MS,
		// Ownership is Mandrill's own ceremony and its own timestamp — absent means
		// Mandrill still rejects this domain as `unsigned`, however good the DNS is.
		isOwnershipVerified: details?.verifiedAt !== undefined,
		...(details?.lastError !== undefined ? { lastError: details.lastError } : {}),
		spfProof: 'dns_required',
	});
}
