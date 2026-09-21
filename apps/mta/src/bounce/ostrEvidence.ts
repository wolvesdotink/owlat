/**
 * OSTR observer-mode evidence capture on the inbound path (plan §7.2).
 *
 * An OSTR spam report is only worth anything if the accused can check it: the
 * observer must be able to show, offline and long after the connection closed,
 * that the reported message really did carry a DKIM signature that verified for
 * the domain being reported. `@owlat/mail-auth` produces exactly that record
 * through its `onSignatureEvidence` seam; this module decides WHICH signature's
 * record to keep, whether it is admissible at all, and what to attach it to.
 *
 * Three rules:
 *
 *   - Keep the signature the AUTHOR DOMAIN is answerable for. A message may
 *     carry several passing signatures, and a signer PREPENDS its own, so the
 *     first one a verifier reports on forwarded or mailing-list mail is the last
 *     hop's, not the author's. Reporting that one would let anyone who touched
 *     the mail be accused for it — the false-accusation risk §7.3 bounds. So the
 *     pick is the passing signature whose `d=` is DMARC-aligned with the
 *     RFC5322.From domain, and only if none aligns does the first pass stand.
 *   - Nothing that is not evidence is kept. `@owlat/ostr-observer`'s
 *     `buildEvidenceBundle` runs the §7.1 admissibility rules (an `l=` tag, RSA
 *     under 2048 bits, or a signature not covering From/Date/Message-ID is not
 *     evidence) plus the capture-completeness checks, and a record that fails
 *     them is dropped HERE rather than shipped for a consumer to discover.
 *   - Nothing is captured unless the operator turned observer mode on. It is an
 *     env switch, not a feature flag, because it governs what leaves the
 *     building: raw signed headers and a point-in-time DNS key record.
 *
 * WHAT THIS MODULE DOES NOT DO, and who owns it. The bundle built here is a
 * GATE, not a product: it is hashed and thrown away, and the raw record travels
 * to Convex, because the junk action — the moment a user calls a message spam —
 * is what turns a record into a report, and it lives there. The consumer that
 * builds the real bundle therefore still owes the other two §7 gates, neither
 * of which the MTA can answer: `assertObserverEligible` /
 * `OBSERVER_MIN_MAILBOXES` (§7.4 hard-disables observer mode below the mailbox
 * floor — the MTA does not know the mailbox count) and the ~90-day retention
 * cutoff of §7.2 (the MTA retains nothing; Convex stores the payload).
 */

import type { DkimSignatureEvidence } from '@owlat/mail-auth';
import { buildEvidenceBundle } from '@owlat/ostr-observer';
import { isSpfAligned } from '@owlat/shared/spfAlignment';
import { logger } from '../monitoring/logger.js';

/**
 * Cap on the passing signatures held for selection. A message can carry
 * arbitrarily many `DKIM-Signature` fields, and the selection only ever needs
 * an aligned one or the first — holding the rest would let a crafted message
 * size the capture.
 */
const MAX_CAPTURED_SIGNATURES = 8;

/**
 * The evidence blob as it travels to Convex: the verifier's record plus the two
 * facts only the receiving MTA knows — which message it belongs to, and when it
 * was checked (the key record is a point-in-time observation; without the
 * instant it is unfalsifiable).
 */
export interface OstrDkimEvidencePayload extends DkimSignatureEvidence {
	/** RFC 3339 instant the signature was verified at. */
	readonly verifiedAt: string;
	/**
	 * `Message-ID` of the verified message, exactly as the payload's own
	 * `messageId` carries it (angle brackets intact, as `parseMessage` yields
	 * them), so the evidence and the stored message correlate on a string
	 * comparison — the property `ostrInboundSignal.test.ts` pins off a real
	 * `onData` run. A message that carried none has no admissible evidence at
	 * all (§7.1 requires the signature to cover `Message-ID`, and §7.3 dedupes
	 * on it), so this is never the empty string in a payload that survives
	 * {@link buildOstrDkimEvidence}.
	 *
	 * `@owlat/ostr-observer`'s `EvidenceInput.messageId` is documented as the
	 * value only, and it stores what it is handed — so folding the brackets off
	 * is the CONSUMER's step, not the wire's and not the package's. It happens
	 * once, downstream, in `captureOne` (`apps/api/convex/ostr/observer.ts`),
	 * which is the one place that derives either the §7.3 dedupe key or the
	 * bundle hash: the wire keeps the form that correlates with the stored
	 * message, and both values a second implementation must reproduce are taken
	 * over the value only.
	 *
	 * The bundle built below is only an admissibility GATE and is thrown away,
	 * so it is fed the wire form: no hash of it is kept, and every §7.1 rule it
	 * runs is about the signature, not about this field's spelling.
	 */
	readonly messageId: string;
}

/** A capture handle: the callback plus the selection over what it caught. */
export interface OstrEvidenceCapture {
	/** Pass to `verifyDkim`'s `onSignatureEvidence`. */
	readonly onSignatureEvidence: (evidence: DkimSignatureEvidence) => void;
	/**
	 * The signature a report may name: the passing one aligned with
	 * `fromDomain`, else the first that passed. `undefined` when none did.
	 */
	select(fromDomain: string | undefined): DkimSignatureEvidence | undefined;
}

/**
 * Whether `signingDomain` is DMARC-aligned with the RFC5322.From domain.
 *
 * Relaxed alignment (RFC 7489 §3.1's default `adkim=r`), over the shared
 * predicate the DMARC evaluator itself uses, so "aligned" means one thing in
 * this repo. A domain publishing `adkim=s` narrows its own DMARC verdict, but
 * not this pick: a strict-mode mismatch inside one organizational domain is
 * still the same party answering for the mail, which is what the selection is
 * about — never accusing a DIFFERENT party.
 */
export function isDomainAligned(signingDomain: string, fromDomain: string | undefined): boolean {
	if (fromDomain === undefined || fromDomain === '') {
		return false;
	}
	return isSpfAligned(signingDomain, fromDomain, 'relaxed');
}

/**
 * Capture every passing signature's evidence (bounded), for
 * {@link OstrEvidenceCapture.select} to choose between once the From domain is
 * known. `verifyDkim` reports in DOCUMENT order, which is newest-signer-first,
 * so "the first one" is emphatically not "the author's" — see the module doc.
 */
export function createOstrEvidenceCapture(): OstrEvidenceCapture {
	const passing: DkimSignatureEvidence[] = [];
	return {
		onSignatureEvidence: (evidence) => {
			if (evidence.verificationVerdict === 'pass' && passing.length < MAX_CAPTURED_SIGNATURES) {
				passing.push(evidence);
			}
		},
		select: (fromDomain) =>
			passing.find((evidence) => isDomainAligned(evidence.signingDomain, fromDomain)) ?? passing[0],
	};
}

/**
 * Build the payload blob, or `undefined` when there is nothing REPORTABLE.
 *
 * Two ways to get nothing: no signature verified, or the one that did is not
 * admissible evidence under §7.1. Both yield no evidence at all rather than a
 * partial record — an evidence bundle that cannot be re-verified is worse than
 * none, because it looks like proof.
 */
export function buildOstrDkimEvidence(
	evidence: DkimSignatureEvidence | undefined,
	messageId: string | undefined,
	verifiedAt: Date
): OstrDkimEvidencePayload | undefined {
	if (evidence === undefined) {
		return undefined;
	}
	const payload: OstrDkimEvidencePayload = {
		...evidence,
		verifiedAt: verifiedAt.toISOString(),
		messageId: messageId ?? '',
	};
	// The bundle itself is discarded: what is wanted is the verdict of the §7.1
	// admissibility rules plus the capture-completeness checks, run by the same
	// code the eventual report will run, so this MTA cannot ship a record that
	// package would refuse.
	const admissible = buildEvidenceBundle(payload);
	if (!admissible.ok) {
		logger.debug(
			{ signingDomain: evidence.signingDomain, reasons: admissible.reasons },
			'OSTR evidence discarded — not admissible (§7.1)'
		);
		return undefined;
	}
	return payload;
}
