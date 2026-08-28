/**
 * Personal-mail delivery pipeline — inbound malware scan.
 *
 * Named `deliveryPipeline/` rather than `delivery/` so it never reads as a
 * sibling of the top-level `convex/delivery/` domain (the provider-agnostic
 * campaign send pipeline); this family is the INBOUND path behind
 * `mail/delivery.ts`.
 */

import { extractAttachments } from '@owlat/shared/mailMime';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { scanAttachmentBytes } from '../mtaClient';

/**
 * Scan an inbound message's attachments for malware before mailbox delivery.
 *
 * ClamAV runs only in the MTA container, so the Convex inbound path POSTs each
 * non-inline attachment leaf to the MTA `/scan/attachment` endpoint (the same
 * endpoint the outbound send path uses — see `mail/outbound.ts` and
 * `delivery/worker.ts`). Defense-in-depth on the RECEIVING side: without this,
 * inbound mail lands in the mailbox with `virusVerdict` undefined, so the
 * `infected → Spam` routing in `deliverToMailbox` can never fire.
 *
 * Returns the aggregate verdict across all attachments:
 *   - `'infected'` — at least one attachment was confirmed malware. The caller
 *     routes the message to Spam/quarantine.
 *   - `'skipped'` — the scanner was unreachable / errored / failed open for at
 *     least one attachment (and none were confirmed infected). Fail-open: the
 *     message is still delivered, but the skip is surfaced via
 *     `lib/scannerHealth.warnScanSkipped` so the operator sees it in the logs.
 *   - `'clean'` — every attachment was scanned and came back clean.
 *   - `undefined` — there was nothing to scan (no attachments) or the MTA is
 *     not configured, so no verdict is asserted (leaves the row's prior verdict
 *     untouched).
 *
 * Pure (no Convex ctx): takes the raw MIME + resolved MTA config so it can be
 * unit-tested with a `fetch` spy, mirroring `deliveryHooks.forwardToTarget`.
 */
export async function scanInboundAttachments(
	mta: { baseUrl: string; apiKey: string } | null,
	rawBytes: Buffer
): Promise<'clean' | 'infected' | 'skipped' | undefined> {
	if (!mta) return undefined; // scanner not configured → no verdict asserted

	// The extractor wants a binary string (one char per byte) so binary parts survive.
	const parts = extractAttachments(rawBytes.toString('latin1'));
	// Only real (non-inline) attachment leaves carry a malware risk worth gating
	// delivery on; inline images (logos/signatures) are skipped, matching the
	// `captureAttachments` policy.
	const candidates = parts.filter((p) => p.disposition !== 'inline' && p.bytes.byteLength > 0);
	if (candidates.length === 0) return undefined; // nothing to scan

	let scannedAny = false;
	let anySkipped = false;
	let scanned = 0;
	for (const part of candidates) {
		// Bound the work: the inbound webhook is attacker-reachable, so a crafted
		// .eml with many leaves must not amplify per-message scan cost. Cap on the
		// same count `captureAttachments` uses.
		if (scanned >= ATTACHMENT_COMPOSE_LIMITS.maxCount) break;
		scanned++;
		const filename = part.filename || 'attachment';
		const data = Buffer.from(part.bytes);
		// Shared client owns the POST + fail-open (scanner-down / network error
		// resolve to 'skipped' and are surfaced via warnScanSkipped). This
		// path's POLICY: AGGREGATE the per-part verdicts — a single confirmed
		// infection short-circuits to quarantine; any skip downgrades the
		// aggregate to 'skipped'.
		const verdict = await scanAttachmentBytes(mta, filename, data);
		if (verdict.kind === 'infected') {
			// Confirmed malware — short-circuit; the message goes to quarantine.
			return 'infected';
		}
		if (verdict.kind === 'skipped') {
			anySkipped = true;
			continue;
		}
		scannedAny = true;
	}

	if (anySkipped) return 'skipped';
	if (scannedAny) return 'clean';
	return undefined;
}
