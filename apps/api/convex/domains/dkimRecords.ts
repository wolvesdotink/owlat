/**
 * A sending domain's DKIM record list: which records decide anything, and the
 * edit that adds or removes the optional Ed25519 record. Pure.
 *
 * The list holds the RSA record the MTA signs with first, a record a rotation
 * added (`rotationPending`) next, and the optional Ed25519 record (`optional`)
 * last. Verification results line up with records by position, so an edit
 * keeps every result that still belongs to its record.
 */

import type { Infer } from 'convex/values';
import type { dnsRecordValidator, verificationResultValidator } from '../lib/convexValidators';

type DnsRecord = Infer<typeof dnsRecordValidator>;
type VerificationResult = Infer<typeof verificationResultValidator>;

/**
 * Whether a DKIM record (or its verification result) decides the domain's
 * verdict and readiness. A rotation's pending selector does not sign yet, and
 * the Ed25519 record is optional: neither can break signing.
 */
export function isDecidingDkim(record: { rotationPending?: boolean; optional?: boolean }): boolean {
	return record.rotationPending !== true && record.optional !== true;
}

/** The DNS record for a domain's optional Ed25519 key. */
export function ed25519DkimRecord(key: { selector: string; dnsRecord: string }): DnsRecord {
	return { type: 'TXT', host: `${key.selector}._domainkey`, value: key.dnsRecord, optional: true };
}

/**
 * Replace the optional record (or drop it, for `null`), keeping the results of
 * the records that stay. A new record goes last and has no result until the
 * next DNS check; re-adding the record already listed keeps its result.
 */
export function withOptionalDkimRecord(
	dkim: readonly DnsRecord[],
	results: readonly VerificationResult[] | undefined,
	record: DnsRecord | null
): { dkim: DnsRecord[]; results: VerificationResult[] | undefined } {
	const nextDkim: DnsRecord[] = [];
	const nextResults: VerificationResult[] = [];
	// A missing result means "not checked yet". Results stop at the first gap,
	// so none of them shifts onto another record.
	let resultsAligned = results !== undefined;
	for (const [i, existing] of dkim.entries()) {
		if (existing.optional === true) continue;
		nextDkim.push(existing);
		const result = results?.[i];
		if (resultsAligned && result) nextResults.push(result);
		else resultsAligned = false;
	}
	if (record) {
		const previous = dkim.findIndex(
			(r) => r.optional === true && r.host === record.host && r.value === record.value
		);
		const previousResult = previous >= 0 ? results?.[previous] : undefined;
		nextDkim.push(record);
		if (resultsAligned && previousResult) nextResults.push(previousResult);
	}
	return { dkim: nextDkim, results: results === undefined ? undefined : nextResults };
}
