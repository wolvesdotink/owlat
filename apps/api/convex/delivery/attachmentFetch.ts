'use node';

/**
 * The worker's attachment step: get each attachment's bytes, check the file
 * type, and run the malware scan. Split out of `worker.ts` for the ~500 LOC cap.
 *
 * Bytes come from one of two places. A ref with a `storageId` names a blob in
 * this deployment's own storage (a Team inbox reply's attachment) and is read
 * directly: there is nothing to guard, and a self-hosted deployment's storage
 * URL need not be reachable over public https at all. Every other ref is a URL
 * a Template API caller supplied, fetched through the SSRF guard.
 *
 * ClamAV is fail-open: when the MTA scan endpoint is unavailable, file-type
 * validation alone gates the send.
 */

import type { ActionCtx } from '../_generated/server';
import { getMtaConfig, scanAttachmentBytes } from '../mail/mtaClient';
import { fetchGuarded } from '../lib/ssrfGuard';
import type { AttachmentRef } from './sendComposition';

type ResolvedAttachment = { filename: string; content: Uint8Array; contentType?: string };

async function readAttachmentBytes(
	storage: Pick<ActionCtx['storage'], 'get'>,
	att: AttachmentRef
): Promise<Buffer> {
	if (att.storageId) {
		const blob = await storage.get(att.storageId);
		if (!blob) throw new Error(`Attachment "${att.filename}" is no longer stored`);
		return Buffer.from(await blob.arrayBuffer());
	}
	// SSRF guard: the attachment URL is attacker-influenced (any API-key
	// holder can supply it) and the fetched bytes are emailed back to an
	// attacker-chosen recipient. Validate the destination against the
	// private/internal blocklist and refuse redirects (https:// only —
	// uploadAttachments already enforces the scheme up front). 15s cap.
	const res = await fetchGuarded(att.url, {
		protocols: ['https:'],
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		throw new Error(
			`Failed to fetch attachment "${att.filename}": ${res.status} ${res.statusText}`
		);
	}
	return Buffer.from(await res.arrayBuffer());
}

// Read + validate + scan every attachment ref.
export async function resolveAttachments(
	storage: Pick<ActionCtx['storage'], 'get'>,
	refs: AttachmentRef[]
): Promise<ResolvedAttachment[]> {
	return Promise.all(
		refs.map(async (att) => {
			const content = await readAttachmentBytes(storage, att);

			// Security: Validate file type before sending
			const { validateFile } = await import('@owlat/email-scanner/files');
			const firstBytes = new Uint8Array(content.subarray(0, 32));
			// Probe the ISO 9660 descriptor at offset 0x8001 to catch renamed ISOs.
			const isoProbe =
				content.length >= 0x8006 ? new Uint8Array(content.subarray(0x8001, 0x8006)) : undefined;
			const fileValidation = validateFile(
				att.filename,
				firstBytes,
				undefined,
				content.length,
				isoProbe
			);

			if (!fileValidation.allowed) {
				throw new Error(`Attachment "${att.filename}" blocked: ${fileValidation.reason}`);
			}

			// Security: ClamAV malware scan via the shared MTA client. The client
			// owns the POST + fail-open (not-configured / scanner-down / network
			// error all resolve to 'skipped' and are surfaced via warnScanSkipped)
			// AND the single config source — this path no longer reads
			// MTA_INTERNAL_URL/MTA_API_KEY itself, so it can't drift from
			// getMtaConfig() (which also accepts MTA_API_URL as a fallback). This
			// path's POLICY: a confirmed-infected verdict throws so the send aborts.
			const scanVerdict = await scanAttachmentBytes(getMtaConfig(), att.filename, content);
			if (scanVerdict.kind === 'infected') {
				throw new Error(
					`Attachment "${att.filename}" blocked by malware scan: ${scanVerdict.reason}`
				);
			}
			// The endpoint's own type gate refused it. Reachable only if its
			// allowlist is stricter than the `validateFile` call above, and it is
			// not malware — so it aborts the send with the type reason, not with
			// a malware sentence.
			if (scanVerdict.kind === 'refused') {
				throw new Error(`Attachment "${att.filename}" blocked: ${scanVerdict.reason}`);
			}

			return {
				filename: att.filename,
				content,
				contentType: att.contentType,
			};
		})
	);
}
