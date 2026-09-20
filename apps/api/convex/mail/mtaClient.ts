/**
 * Shared MTA HTTP client configuration.
 *
 * Single source of truth for resolving the MTA base URL + bearer token from
 * the environment. Used by every outbound/cache-push/delivery-hook action that
 * talks to the MTA over HTTP.
 *
 * The base URL prefers `MTA_INTERNAL_URL` (the in-cluster/private address) and
 * falls back to the public `MTA_API_URL`, mirroring the attachment-scan path.
 * The trailing slash is trimmed so callers can append `/path` directly.
 */

import { getOptional } from '../lib/env';
import { logError } from '../lib/runtimeLog';
import { warnScanSkipped } from '../lib/scannerHealth';

export interface MtaConfig {
	baseUrl: string;
	apiKey: string;
}

export function getMtaConfig(): MtaConfig | null {
	const baseUrl = getOptional('MTA_INTERNAL_URL') ?? getOptional('MTA_API_URL');
	const apiKey = getOptional('MTA_API_KEY');
	if (!baseUrl || !apiKey) return null;
	return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

export interface MailSyncConfig {
	baseUrl: string;
	apiKey: string;
}

/**
 * Resolve the mail-sync worker base URL + bearer token — the transport a
 * connected external (BYO IMAP/SMTP) mailbox sends and receives through. Single
 * source of truth for "is the external worker configured?": null iff either
 * `MAIL_SYNC_API_URL` or `MAIL_SYNC_API_KEY` is unset. The trailing slash is
 * trimmed so callers can append `/path` directly.
 */
export function getMailSyncConfig(): MailSyncConfig | null {
	const baseUrl = getOptional('MAIL_SYNC_API_URL');
	const apiKey = getOptional('MAIL_SYNC_API_KEY');
	if (!baseUrl || !apiKey) return null;
	return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

/** Raw `/scan/attachment` response body shape. */
interface AttachmentScanResponse {
	clean: boolean;
	virus?: string;
	reason?: string;
	skipped?: boolean;
	/**
	 * WHICH gate answered. The endpoint runs its file-type allowlist BEFORE
	 * ClamAV and answers a refusal with the same `clean: false` shape a virus
	 * gets, tagged `'file_type_validation'` (see `apps/mta/src/routes/scan.ts`).
	 * Without reading it, a legacy `.doc` — an OLE2 container the type gate used
	 * to call an installer — came back indistinguishable from a trojan.
	 */
	stage?: string;
}

/** The `stage` the MTA tags a refusal from its file-type allowlist with. */
const FILE_TYPE_REFUSAL_STAGE = 'file_type_validation';

/**
 * The attachment's filename, as a value that can legally be an HTTP header.
 *
 * AN HTTP HEADER VALUE IS A ByteString: every code unit has to be ≤ U+00FF, and
 * CR, LF and NUL are refused outright. A filename is SENDER-CHOSEN and arrives
 * already RFC 2047-decoded (`@owlat/shared/mailMime`), so `рахунок.pdf`,
 * `請求書.pdf` and a header-injection attempt all make a real `fetch` THROW
 * before it opens a socket — and the catch below turns every throw into
 * `'skipped'`. That is a scanner bypass one encoded-word away: attach
 * `=?UTF-8?B?…?=.exe`, and the bytes are never scanned while the download stays
 * live. (The suites could not see it because a `vi.fn` stub never validates a
 * header value; `stubScanner` now builds a real `Headers` first.)
 *
 * Percent-encoded rather than stripped so the MTA still sees the real name: the
 * encoding leaves every ASCII letter, digit and `.` alone, so the extension the
 * file-type allowlist judges is untouched — `invoice.pdf.exe` goes over the
 * wire verbatim — while nothing sender-chosen can throw or inject. The MTA
 * decodes it (`apps/mta/src/routes/scan.ts`); an MTA too old to decode sees a
 * mangled non-ASCII name and still judges the right extension.
 */
function encodeFilenameHeader(filename: string): string {
	return encodeURIComponent(filename);
}

/**
 * Normalized verdict from {@link scanAttachmentBytes}. The three outbound /
 * inbound scan sites each interpret this per their own policy:
 *   - `'infected'` — confirmed malware. The reason is the scanner's virus name
 *     / message. Callers decide: throw a typed error (postbox outbound),
 *     short-circuit the aggregate to infected (inbound), or throw a flagged
 *     error inline (the campaign worker).
 *   - `'skipped'` — the scanner was not configured, unreachable, errored, or
 *     explicitly skipped this file. ALREADY surfaced via
 *     `scannerHealth.warnScanSkipped` inside the client (except the
 *     not-configured case, which is silent by design). Fail-open: the caller
 *     proceeds without a clean assertion.
 *   - `'refused'` — the endpoint's file-type allowlist would not pass this
 *     file through, and ClamAV never ran. NOT a malware finding: the reason is
 *     a policy sentence about the type, and a caller that renders it as
 *     "malware was found" is lying about a customer's legacy Word document.
 *   - `'clean'` — the file was scanned and came back clean.
 */
export type AttachmentScanVerdict =
	| { kind: 'clean' }
	| { kind: 'infected'; reason: string }
	| { kind: 'refused'; reason: string }
	| { kind: 'skipped'; reason?: string };

/**
 * POST a single attachment's bytes to the MTA `/scan/attachment` endpoint and
 * normalize the outcome to an {@link AttachmentScanVerdict}.
 *
 * This is the SINGLE source for the scan POST (URL, headers, body framing) and
 * for the fail-open contract: every non-infected failure mode — scanner not
 * configured, HTTP error, network/parse error, explicit `skipped` — resolves to
 * `'skipped'` rather than throwing, and (except the silent not-configured case)
 * is surfaced once via `scannerHealth.warnScanSkipped`. ClamAV unavailability
 * must never wedge a send/deliver path; only a CONFIRMED-infected verdict gives
 * the caller something to gate on, and even then the gating POLICY (throw /
 * aggregate / flag) stays at the call site.
 *
 * Pure over its `mta` arg (no Convex ctx), so it can be unit-tested with a
 * `fetch` spy — mirroring `mail/delivery.scanInboundAttachments`.
 */
export async function scanAttachmentBytes(
	mta: MtaConfig | null,
	filename: string,
	data: Uint8Array
): Promise<AttachmentScanVerdict> {
	if (!mta) return { kind: 'skipped' }; // scanner not configured → fail-open, silent

	try {
		const res = await fetch(`${mta.baseUrl}/scan/attachment`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${mta.apiKey}`,
				'Content-Type': 'application/octet-stream',
				'X-Filename': encodeFilenameHeader(filename),
			},
			body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
		});

		if (!res.ok) {
			// Scanner reachable but errored (e.g. 503) → fail open, surfaced.
			const reason = `scanner returned HTTP ${res.status}`;
			warnScanSkipped(filename, reason);
			return { kind: 'skipped', reason };
		}

		const result = (await res.json()) as AttachmentScanResponse;
		if (!result.clean && !result.skipped) {
			// The type gate, not the virus gate. Told apart HERE, once, because
			// the difference decides whether a message is quarantined and its
			// reader told malware was found in it.
			if (result.stage === FILE_TYPE_REFUSAL_STAGE) {
				return {
					kind: 'refused',
					reason: result.reason ?? 'file type not accepted',
				};
			}
			return {
				kind: 'infected',
				reason: result.reason ?? result.virus ?? 'unknown threat',
			};
		}
		if (result.skipped) {
			warnScanSkipped(filename, result.reason);
			return { kind: 'skipped', reason: result.reason };
		}
		return { kind: 'clean' };
	} catch (err) {
		// Network / DNS / parse failure → fail open, but surface the skip.
		const reason = err instanceof Error ? err.message : String(err);
		logError(`[mta] attachment scan unavailable for ${filename}:`, err);
		warnScanSkipped(filename, reason);
		return { kind: 'skipped', reason };
	}
}
