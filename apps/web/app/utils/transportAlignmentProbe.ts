/**
 * Live-DNS gather for the transport wizard's alignment step (P2-4).
 *
 * The DECISION is not made here. This module resolves the three TXT names the
 * shipped pre-flight reads — the From domain, `_dmarc.<from>` and one
 * `<selector>._domainkey.<d>` per arm — over the shipped DNS-over-HTTPS helper,
 * and hands them to `evaluateAlignmentPreflight`, which runs the SAME four
 * checks and the SAME SPF coexistence detector (10-lookup accounting included)
 * that the daily sweep and the ramp gate run. One evaluator, one verdict, one
 * set of remedies — the wizard can never tell an operator something the
 * controller disagrees with.
 *
 * DNS failure semantics are the pre-flight's, preserved exactly: a timeout,
 * SERVFAIL or REFUSED is `unknown` (hold), never "absent" and never "aligned".
 * `dohQuery` fails soft to `null`, which is a lookup we could not make — also
 * `unknown`.
 */

import {
	dkimRecordName,
	evaluateAlignmentPreflight,
	normalizeDomain,
	type AlignmentDnsFacts,
	type AlignmentPreflightResult,
	type AlignmentArm,
	type DnsTxtObservation,
	type ReferenceArmInput,
} from '@owlat/shared/deliverabilityAlignment';
import { dohQuery, DNS_TYPE_TXT, DNS_STATUS_NXDOMAIN } from './doh';

/** DoH JSON `Status` values we distinguish beyond NXDOMAIN (RFC 1035 §4.1.1). */
const DNS_STATUS_NOERROR = 0;
const DNS_STATUS_SERVFAIL = 2;
const DNS_STATUS_REFUSED = 5;

/**
 * Unwrap a DoH TXT payload: one or more double-quoted character-strings (RFC
 * 1035 §3.3.14 splits records over 255 bytes), concatenated with the quotes and
 * backslash escapes removed. Same handling as the shipped SPF coexistence hint.
 */
function unwrapTxtData(data: string): string {
	const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!chunks) return data.trim();
	return chunks.map((chunk) => chunk.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

/** Resolve one TXT name into the pre-flight's three-state observation. */
async function observeTxt(name: string): Promise<DnsTxtObservation> {
	const body = await dohQuery(name, 'TXT');
	if (body === null) return { state: 'unknown', failure: 'error' };
	const status = body.Status ?? DNS_STATUS_NOERROR;
	if (status === DNS_STATUS_SERVFAIL) return { state: 'unknown', failure: 'servfail' };
	if (status === DNS_STATUS_REFUSED) return { state: 'unknown', failure: 'refused' };
	if (status !== DNS_STATUS_NOERROR && status !== DNS_STATUS_NXDOMAIN) {
		return { state: 'unknown', failure: 'error' };
	}
	const records = (body.Answer ?? [])
		.filter((answer) => answer.type === DNS_TYPE_TXT)
		.map((answer) => unwrapTxtData(answer.data));
	return records.length === 0 ? { state: 'absent' } : { state: 'found', records };
}

/** Every DKIM TXT name the two arms between them can sign with. */
function dkimNamesFor(ownArm: AlignmentArm, reference: ReferenceArmInput): string[] {
	const arms: AlignmentArm[] = reference.kind === 'arm' ? [ownArm, reference.arm] : [ownArm];
	const names = new Set<string>();
	for (const arm of arms) {
		for (const selector of arm.dkimSelectors) {
			names.add(dkimRecordName(selector, arm.dkimDomain));
		}
	}
	return [...names];
}

/** Resolve every TXT fact the pre-flight reads for this pair of arms. */
async function gatherAlignmentDns(
	ownArm: AlignmentArm,
	reference: ReferenceArmInput
): Promise<AlignmentDnsFacts> {
	const fromDomain = normalizeDomain(ownArm.fromDomain);
	const dkimNames = dkimNamesFor(ownArm, reference);
	// Nested rather than one flat `Promise.all([a, b, ...spread])`: the spread
	// erases the tuple type, and the two named facts would come back as
	// `DnsTxtObservation | undefined`.
	const [[fromDomainTxt, dmarcTxt], dkimObservations] = await Promise.all([
		Promise.all([observeTxt(fromDomain), observeTxt(`_dmarc.${fromDomain}`)]),
		Promise.all(dkimNames.map((name) => observeTxt(name))),
	]);
	const dkimTxt: Record<string, DnsTxtObservation> = {};
	dkimNames.forEach((name, index) => {
		const observation = dkimObservations[index];
		if (observation !== undefined) dkimTxt[name] = observation;
	});
	return { fromDomainTxt, dmarcTxt, dkimTxt };
}

/**
 * The wizard's alignment step: gather live DNS, then run the shipped evaluator.
 * `checkedAt` is a parameter so the caller owns the clock (D15 applies to the
 * evaluator; this shell simply refuses to invent one).
 */
export async function runAlignmentProbe(
	ownArm: AlignmentArm,
	reference: ReferenceArmInput,
	checkedAt: number
): Promise<AlignmentPreflightResult> {
	const dns = await gatherAlignmentDns(ownArm, reference);
	return evaluateAlignmentPreflight({ ownArm, reference, dns, checkedAt });
}
