/**
 * Personal-mail delivery pipeline — inbound malware scan.
 *
 * Named `deliveryPipeline/` rather than `delivery/` so it never reads as a
 * sibling of the top-level `convex/delivery/` domain (the provider-agnostic
 * campaign send pipeline); this family is the INBOUND path behind
 * `mail/delivery.ts`.
 */

import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { scanAttachmentBytes } from '../mtaClient';
import type { VirusVerdict } from '../../lib/literalValidators';
import { inboundAttachmentCandidates, type InboundAttachmentPart } from './attachmentParts';

/**
 * What one inbound scan established — the verdict AND the parts it covers.
 *
 * The verdict alone was not enough to keep a promise the pipeline makes
 * ("nothing unscanned reaches a model"): a caller holding only `'clean'` has to
 * re-derive which leaves that verdict was about, and a re-derivation that
 * filters differently is exactly how unscanned bytes reached the summariser.
 * `cleanParts` IS the set, so capture consumes it instead of re-deriving it.
 */
export type InboundScanResult = {
	/**
	 * Aggregate over the parts this scan looked at:
	 *   · `'infected'` — at least one part was confirmed malware. The caller
	 *     routes the message to Spam/quarantine.
	 *   · `'skipped'` — something was NOT established: the scanner was
	 *     unreachable for at least one part, or the per-message cap left a leaf
	 *     unopened. Fail-open: the message still delivers, and the skip is
	 *     surfaced via `lib/scannerHealth.warnScanSkipped`.
	 *   · `'clean'` — every attachment leaf was covered and came back clean.
	 *   · `undefined` — nobody asserted anything: no leaves at all, or no
	 *     scanner here and none upstream. "Nothing to scan" and "nothing
	 *     scanned it" are told apart by `scannableCount`, not by the verdict,
	 *     because a row must never store `undefined` as `'clean'`.
	 */
	verdict?: VirusVerdict;
	/**
	 * The leaves that were scanned and came back CLEAN, in MIME order — the
	 * only bytes of this message that may be fed to a model. Empty on every
	 * other outcome, including `'infected'`.
	 */
	cleanParts: InboundAttachmentPart[];
	/**
	 * How many real attachment leaves the message has at all. Zero says "there
	 * was nothing to scan", which is a different sentence from "we did not scan
	 * it" — a message whose only attachment is a signature logo must not be
	 * reported to the reader as unscanned.
	 */
	scannableCount: number;
};

/**
 * Scan an inbound message's attachments for malware before delivery.
 *
 * ClamAV runs only in the MTA container, so the Convex inbound path POSTs each
 * attachment leaf to the MTA `/scan/attachment` endpoint (the same endpoint the
 * outbound send path uses — see `mail/outbound.ts` and `delivery/worker.ts`).
 * Defense-in-depth on the RECEIVING side: without this, inbound mail lands in
 * the mailbox with `virusVerdict` undefined, so the `infected → Spam` routing
 * in `deliverToMailbox` can never fire.
 *
 * BOUNDED BY COUNT, and the bound is why this returns parts. The inbound
 * webhook is attacker-reachable, so a crafted `.eml` with many leaves must not
 * amplify per-message scan cost; at most `ATTACHMENT_COMPOSE_LIMITS.maxCount`
 * leaves are opened. Whatever the cap withholds is UNSCANNED, and the
 * downstream rule is not "scan ten and ingest ten" but "ingest only what was
 * scanned" — so the cleared parts travel with the verdict.
 *
 * Pure (no Convex ctx): takes the raw MIME + resolved MTA config so it can be
 * unit-tested with a `fetch` spy, mirroring `deliveryHooks.forwardToTarget`.
 */
export async function scanInboundAttachments(
	mta: { baseUrl: string; apiKey: string } | null,
	rawBinary: string,
	/**
	 * A verdict the sender's own pipeline already reached for this message —
	 * the MTA scans on the mailbox route before it forwards. Merged in here
	 * rather than by the caller so the returned verdict and the returned parts
	 * are decided together: an `'infected'` prior clears nothing, and a
	 * `'clean'` prior on an instance with no scanner of its own covers the
	 * whole message, so every leaf counts as cleared.
	 */
	priorVerdict?: VirusVerdict
): Promise<InboundScanResult> {
	// Walked even with no scanner configured, because `scannableCount` is what
	// tells the reader "there was nothing to scan" apart from "nobody scanned
	// it", and only the MIME says which. One walk, shared with capture through
	// the parts this returns.
	const candidates = inboundAttachmentCandidates(rawBinary);
	const scannableCount = candidates.length;
	const nothingCleared: InboundScanResult = {
		verdict: priorVerdict,
		cleanParts: [],
		scannableCount,
	};
	// Confirmed malware, wherever the confirmation came from: nothing out of
	// this message is cleared, and the caller quarantines it.
	if (priorVerdict === 'infected') return { ...nothingCleared, verdict: 'infected' };
	if (scannableCount === 0) return nothingCleared;
	if (!mta) {
		// No scanner of our own. An upstream `'clean'` is a verdict about the
		// WHOLE message, so it clears every leaf; anything else asserts nothing
		// and therefore clears nothing — "we have no scanner" and "this file is
		// safe" are different claims and only one of them is ours to make.
		return priorVerdict === 'clean'
			? { verdict: 'clean', cleanParts: candidates, scannableCount }
			: nothingCleared;
	}

	const budget = ATTACHMENT_COMPOSE_LIMITS.maxCount;
	const cleanParts: InboundAttachmentPart[] = [];
	let anySkipped = false;
	for (const part of candidates.slice(0, budget)) {
		const filename = part.filename || 'attachment';
		// Shared client owns the POST + fail-open (scanner-down / network error
		// resolve to 'skipped' and are surfaced via warnScanSkipped). This
		// path's POLICY: AGGREGATE the per-part verdicts — a single confirmed
		// infection short-circuits to quarantine; any skip downgrades the
		// aggregate to 'skipped'.
		const verdict = await scanAttachmentBytes(mta, filename, part.bytes);
		if (verdict.kind === 'infected') {
			// Confirmed malware — short-circuit; the message goes to quarantine
			// and NOTHING out of it is cleared, not even the leaves already
			// scanned: the message is the unit a reader quarantines.
			return { verdict: 'infected', cleanParts: [], scannableCount };
		}
		if (verdict.kind === 'skipped') {
			anySkipped = true;
			continue;
		}
		cleanParts.push(part);
	}

	// A cap that withheld a leaf is the same kind of gap as a scanner outage:
	// the verdict does not cover the whole message, so it must not read as a
	// clean bill of health for it.
	if (anySkipped || cleanParts.length < scannableCount) {
		return { verdict: 'skipped', cleanParts, scannableCount };
	}
	return { verdict: 'clean', cleanParts, scannableCount };
}
