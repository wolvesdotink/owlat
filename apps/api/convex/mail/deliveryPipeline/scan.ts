/**
 * Inbound delivery pipeline (personal mailbox AND team inbox) — malware scan.
 *
 * Named `deliveryPipeline/` rather than `delivery/` so it never reads as a
 * sibling of the top-level `convex/delivery/` domain (the provider-agnostic
 * campaign send pipeline); this family is the INBOUND path behind
 * `mail/delivery.ts`.
 */

import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { scanAttachmentBytes } from '../mtaClient';
import type { VirusVerdict } from '../../lib/literalValidators';
import {
	inboundAttachmentCandidates,
	NOTHING_UNCLEARED,
	type InboundAttachmentPart,
	type UnclearedLeaves,
} from './attachmentParts';

/**
 * What one inbound scan established — the verdict, the parts it covers, and
 * what it could not cover.
 *
 * The verdict alone was not enough to keep a promise the pipeline makes
 * ("nothing unscanned reaches a model"): `cleanParts` IS the set capture may
 * index, so nothing downstream re-derives it. See
 * `deliveryPipeline/attachmentParts.ts` for what that re-derivation cost.
 */
export type InboundScanResult = {
	/**
	 * Aggregate over the parts this scan looked at:
	 *   · `'infected'` — at least one part was confirmed malware. The caller
	 *     routes the message to Spam/quarantine.
	 *   · `'skipped'` — something was NOT established: the scanner was
	 *     unreachable for at least one part, the per-message cap left a leaf
	 *     unopened, or the endpoint's file-type gate refused a leaf before
	 *     ClamAV ever ran. Fail-open: the message still delivers. An outage is
	 *     surfaced to the operator via `lib/scannerHealth.warnScanSkipped`; a
	 *     refusal and the cap are not outages and warn nothing — the reader is
	 *     told about those on the row, via the capture marker.
	 *   · `'clean'` — every attachment leaf was covered and came back clean.
	 *   · `undefined` — nobody asserted anything: no leaves at all, or no
	 *     scanner here and none upstream. "Nothing to scan" and "nothing
	 *     scanned it" are told apart by `candidates`, not by the verdict,
	 *     because a row must never store `undefined` as `'clean'`.
	 */
	verdict?: VirusVerdict;
	/**
	 * The leaves that were scanned and came back CLEAN, in scan order — the
	 * only bytes of this message that may be fed to a model. Empty on every
	 * other outcome, including `'infected'`.
	 */
	cleanParts: InboundAttachmentPart[];
	/**
	 * Every real attachment leaf the message has, whether or not this scan got
	 * to it. An empty array says "there was nothing to scan", which is a
	 * different sentence from "we did not scan it".
	 *
	 * Carried rather than counted so the one caller that indexes UNSCANNED
	 * leaves by policy (the personal mailbox, on an instance with no scanner)
	 * takes this list instead of walking a 10 MiB string a second time to
	 * rebuild the list the walk above already produced.
	 */
	candidates: InboundAttachmentPart[];
	/**
	 * The leaves the endpoint's FILE-TYPE GATE refused, before ClamAV ever ran.
	 *
	 * Carried, not just counted, because the personal mailbox's no-scanner
	 * fallback indexes the message's own leaves and must leave these out of
	 * that: an `invoice.pdf.exe` is the one leaf on the message whose bytes
	 * nobody will ever look at, and it is not the one to hand a model.
	 */
	typeRefusedParts: InboundAttachmentPart[];
	/** Per cause, how many leaves this scan did not clear. */
	uncleared: UnclearedLeaves;
	/**
	 * Did the MALWARE SCANNER answer about any leaf of this message — clean or
	 * infected — as opposed to nobody having looked at it?
	 *
	 * A file-type REFUSAL is not an answer to this question. The MTA's
	 * allowlist runs BEFORE ClamAV and answers even on a deployment that has no
	 * scanner at all, so counting it here let one `setup.msi` claim the whole
	 * message had been scanned: on a no-ClamAV instance every other leaf came
	 * back a fail-open skip, `cleanParts` was empty, and the reader's own
	 * `contract.pdf` — indexed when sent alone — silently was not.
	 *
	 * NOT the same question as `verdict !== undefined`, and the difference is a
	 * whole deployment. `/scan/attachment` fails OPEN: on an instance whose MTA
	 * runs without the optional `clamav` sidecar every leaf answers
	 * `{clean: true, skipped: true}`, so the aggregate is `'skipped'` and
	 * `cleanParts` is empty even though the verdict is very much defined. A
	 * caller that read "was anything scanned?" off the verdict therefore turned
	 * the personal mailbox's file library off on every no-ClamAV deployment.
	 *
	 * `false` means: no scanner configured here and none upstream, or every
	 * leaf came back a fail-open skip. See {@link mailboxIndexableParts}.
	 */
	scannerAnswered: boolean;
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
	// Walked even with no scanner configured, because the candidate list is what
	// tells the reader "there was nothing to scan" apart from "nobody scanned
	// it", and only the MIME says which. One walk, shared with capture through
	// the parts this returns.
	const candidates = inboundAttachmentCandidates(rawBinary);
	// Nothing looked at this message. Every leaf it carries is therefore
	// UNSCANNED — the count is not zero just because the reason is "there is no
	// scanner here" rather than "the scanner timed out". A message with no
	// leaves at all lands here too, and then the count is honestly zero.
	const nothingCleared: InboundScanResult = {
		verdict: priorVerdict,
		cleanParts: [],
		candidates,
		typeRefusedParts: [],
		uncleared: { ...NOTHING_UNCLEARED, unscanned: candidates.length },
		scannerAnswered: false,
	};
	// Confirmed malware, wherever the confirmation came from: nothing out of
	// this message is cleared, and the caller quarantines it. A quarantine is
	// not a gap in what we looked at, so nothing counts as withheld. One
	// literal for both the prior verdict and the scan loop's own finding — the
	// two are the same outcome and were spelled out twice.
	const quarantined: InboundScanResult = {
		verdict: 'infected',
		cleanParts: [],
		candidates,
		typeRefusedParts: [],
		uncleared: NOTHING_UNCLEARED,
		scannerAnswered: true,
	};
	if (priorVerdict === 'infected') return quarantined;
	if (candidates.length === 0) return nothingCleared;
	if (!mta) {
		// No scanner of our own. An upstream `'clean'` is a verdict about the
		// WHOLE message, so it clears every leaf; anything else asserts nothing
		// and therefore clears nothing — "we have no scanner" and "this file is
		// safe" are different claims and only one of them is ours to make.
		return priorVerdict === 'clean'
			? {
					verdict: 'clean',
					cleanParts: candidates,
					candidates,
					typeRefusedParts: [],
					uncleared: NOTHING_UNCLEARED,
					scannerAnswered: true,
				}
			: nothingCleared;
	}

	const budget = ATTACHMENT_COMPOSE_LIMITS.maxCount;
	const cleanParts: InboundAttachmentPart[] = [];
	const typeRefusedParts: InboundAttachmentPart[] = [];
	let scannerAnswered = false;
	// WHY a leaf went uncleared, not just how many did. The cap and a scanner
	// outage both leave a file unindexed, and the reader is told a different
	// sentence for each — so the causes are counted apart here, at the only
	// place that knows which one applied.
	//
	// ONLY DOCUMENTS COUNT AS CAPPED. Inline leaves are ordered last precisely
	// so the budget is spent on documents first, and they are never indexed
	// anyway (see `capture.ts`) — so an ordinary corporate signature of five
	// logo icons behind six attached `.txt` files used to stamp a fully indexed
	// message "this message has more attachments than it processes", a sentence
	// that was false about every file the sender actually attached.
	//
	// AN INLINE LEAF PAST THE BUDGET IS STILL UNSCANNED, and that half is not
	// cosmetic. The MTA lists any leaf carrying a filename whatever its
	// disposition, so the reader gets a download button for it — and counting
	// it as nothing at all let eleven leaves (ten `.txt` plus an inline
	// `invoice.pdf.exe`) store `'clean'` for a file ClamAV never opened. It is
	// counted under `unscanned` rather than `capped` because that is the true
	// sentence about it — nobody looked at these bytes — while "more
	// attachments than we process" is a claim about documents.
	const beyondBudget = candidates.slice(budget);
	const uncleared: UnclearedLeaves = {
		...NOTHING_UNCLEARED,
		capped: beyondBudget.filter((part) => part.disposition !== 'inline').length,
		unscanned: beyondBudget.filter((part) => part.disposition === 'inline').length,
	};
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
			return quarantined;
		}
		if (verdict.kind === 'refused') {
			// The endpoint's file-type gate, not ClamAV: this file is not
			// malware, it is a type the scanner will not pass through. It is
			// not cleared, it is not a quarantine, and — because no bytes were
			// ever compared to a signature — it is NOT a scanner having
			// answered. Kept as a part so the mailbox's no-scanner fallback can
			// index everything else on the message except this.
			typeRefusedParts.push(part);
			uncleared.refusedType += 1;
			continue;
		}
		if (verdict.kind === 'skipped') {
			uncleared.unscanned += 1;
			continue;
		}
		scannerAnswered = true;
		cleanParts.push(part);
	}

	// A cap that withheld a leaf is the same kind of gap as a scanner outage:
	// the verdict does not cover the whole message, so it must not read as a
	// clean bill of health for it.
	//
	// A FILE-TYPE REFUSAL IS ONE OF THOSE GAPS TOO. The MTA runs `validateFile`
	// BEFORE ClamAV, so `invoice.pdf.exe` comes back `refused` with its bytes
	// never compared to a signature — and the reader can still download it. A
	// row that stored `'clean'` for such a message was asserting a verdict no
	// scanner ever produced for the one leaf in it that most needed one.
	if (uncleared.unscanned > 0 || uncleared.capped > 0 || uncleared.refusedType > 0) {
		return {
			verdict: 'skipped',
			cleanParts,
			candidates,
			typeRefusedParts,
			uncleared,
			scannerAnswered,
		};
	}
	return { verdict: 'clean', cleanParts, candidates, typeRefusedParts, uncleared, scannerAnswered };
}

/**
 * What the PERSONAL MAILBOX may index out of a scan, and what it must report
 * as withheld — the pair, decided in one place.
 *
 * The two answers must always agree: indexing the message's own leaves while
 * reporting the scan's uncleared counts would tell a reader files were withheld
 * that were in fact indexed. They were two independent ternaries at the call
 * site, testing the same thing and only agreeing by inspection.
 *
 * THE POLICY. When the malware scanner answered about this message, the mailbox
 * indexes exactly what came back clean — an infected message and a partly-scanned
 * one index nothing and something respectively, and the counts say why. When
 * NOBODY answered, the mailbox keeps its long-standing behaviour and indexes the
 * message's own attachment leaves: this is the owner's own mail, and switching
 * the file library off on every deployment that runs without the optional
 * `clamav` sidecar is not a change this route makes on the way past.
 *
 * MINUS THE TYPE-REFUSED LEAVES, on that fallback branch. The file-type gate
 * runs before ClamAV and answers on a deployment that has none, so those leaves
 * ARE known to be the ones nobody will ever scan; handing them to a model
 * because no scanner was reachable would index exactly the bytes least worth
 * indexing. They are the one thing withheld there, and the reader is told.
 *
 * The TEAM INBOX has no such branch — it is attacker-reachable by design, so
 * unscanned is never indexed there — which is why this is a mailbox helper and
 * not a field on the result.
 */
export function mailboxIndexableParts(scan: InboundScanResult): {
	parts: InboundAttachmentPart[];
	withheld: UnclearedLeaves;
} {
	if (scan.scannerAnswered) return { parts: scan.cleanParts, withheld: scan.uncleared };
	const refused = new Set(scan.typeRefusedParts);
	return {
		parts: scan.candidates.filter((part) => !refused.has(part)),
		withheld: { ...NOTHING_UNCLEARED, refusedType: scan.typeRefusedParts.length },
	};
}
