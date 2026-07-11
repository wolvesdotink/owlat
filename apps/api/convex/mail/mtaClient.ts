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
 *   - `'clean'` — the file was scanned and came back clean.
 */
export type AttachmentScanVerdict =
	| { kind: 'clean' }
	| { kind: 'infected'; reason: string }
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
	data: Buffer
): Promise<AttachmentScanVerdict> {
	if (!mta) return { kind: 'skipped' }; // scanner not configured → fail-open, silent

	try {
		const res = await fetch(`${mta.baseUrl}/scan/attachment`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${mta.apiKey}`,
				'Content-Type': 'application/octet-stream',
				'X-Filename': filename,
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
