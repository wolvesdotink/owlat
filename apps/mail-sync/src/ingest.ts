/**
 * Parse a raw RFC822 message (in-house `@owlat/mail-message.parseMessage`) and
 * hand it to Convex for insertion via the `ingestExternalRaw` action.
 *
 * The raw bytes go OUT OF BAND first, to the `/mail-sync/raw-message` HTTP
 * action, which answers with a storage id. They used to ride along as a base64
 * ARGUMENT, and Convex caps a function-call body at 16 MiB: with base64's 4/3
 * inflation that silently rejected every message over ~12 MiB of source — on a
 * real mailbox about one message in twenty — at the backend's HTTP layer,
 * before any ingest code ran. HTTP action bodies have no such cap, and what is
 * left in the call's arguments is bounded by construction.
 */

import { parseMessage, type AddressObject } from '@owlat/mail-message';
import type { ConvexClient } from './convex.js';
import { fn } from './convex.js';
import type { FolderRole } from './folders.js';

// Bodies still ride inside the action call; cap them so a pathological message
// can't blow Convex's per-call arg limit. Over-cap bodies
// are truncated to a byte-accurate prefix (rare; HTML email bodies are ~tens of
// KB) so the server still derives a usable snippet + preview; the full message
// is always preserved in the raw .eml blob regardless.
const WIRE_BODY_LIMIT = 1024 * 1024; // 1 MB

/**
 * How much of the message the ingest action needs to read headers from. It
 * extracts List-Unsubscribe and the RFC 3834 anti-loop headers and nothing
 * else, and 64 KiB covers the header section of any real message — the same
 * slice the action used to take off the inline raw bytes itself.
 */
const HEADER_BLOCK_BYTES = 64 * 1024;

function capBody(body: string | undefined): string | undefined {
	if (!body) return undefined;
	body = body.toWellFormed();
	if (Buffer.byteLength(body, 'utf-8') <= WIRE_BODY_LIMIT) return body;
	// Truncate by bytes without splitting a multibyte char (a trailing partial
	// sequence decodes to U+FFFD, harmless for a preview).
	const prefix = Buffer.from(body, 'utf-8').subarray(0, WIRE_BODY_LIMIT);
	return new TextDecoder('utf-8').decode(prefix);
}

function addrList(field: AddressObject | AddressObject[] | undefined): string[] {
	if (!field) return [];
	const objs = Array.isArray(field) ? field : [field];
	const out: string[] = [];
	for (const o of objs) {
		for (const v of o.value ?? []) {
			if (v.address) out.push(v.address.toWellFormed());
		}
	}
	return out;
}

/**
 * The single address of a `From:`-shaped field — the first parsed mailbox, or
 * `''` when the header is absent/address-less. `parseMessage` collapses a
 * repeated `From:` to the LAST instance (mailparser `singleKeys` parity), so it
 * hands us a single {@link AddressObject}; the array arm is a defensive fallback
 * that reads the LAST object, which stays consistent with that collapse and with
 * the old `parsed.from?.value?.[0]?.address` extraction (mailparser also kept the
 * last `From:`).
 */
function primaryAddress(field: AddressObject | AddressObject[] | undefined): string {
	const obj = Array.isArray(field) ? field[field.length - 1] : field;
	return obj?.value[0]?.address?.toWellFormed() ?? '';
}

/**
 * The display text of a `Reply-To:`-shaped field — the formatted address that
 * mailparser exposed as `.text`. `parseMessage` collapses a repeated `Reply-To:`
 * to the LAST instance (mailparser `singleKeys` parity), so it hands us a single
 * {@link AddressObject}; the array arm is a defensive fallback that reads the
 * LAST object's text, consistent with that collapse. An absent header yields
 * `undefined`.
 */
function addrText(field: AddressObject | AddressObject[] | undefined): string | undefined {
	if (!field) return undefined;
	return (Array.isArray(field) ? field[field.length - 1]?.text : field.text)?.toWellFormed();
}

/**
 * Fabricate a Message-ID for a message whose source has none.
 *
 * This MUST be deterministic from the message's stable remote identity — never
 * time-based. Ingest dedups strictly on Message-ID within a mailbox, and the
 * backfill walker only persists its cursor once per batch, so a mid-batch crash
 * re-fetches the range. If the synthetic id changed each run (e.g. `Date.now()`),
 * a header-less message would get a fresh id on re-fetch, miss dedup, and be
 * inserted twice. Keying on `(uidvalidity, uid, remoteName)` — the IMAP-stable
 * coordinates of the message — makes re-fetch produce the same id, so dedup
 * catches it. `remoteName` is sanitised to keep the id a valid addr-spec token.
 */
export function syntheticMessageId(params: {
	remoteUidValidity: number;
	remoteUid: number;
	remoteName: string;
}): string {
	const folder = params.remoteName.replace(/[^A-Za-z0-9._-]+/g, '_');
	return `<${params.remoteUidValidity}.${params.remoteUid}.${folder}@owlat-mail-sync>`;
}

export interface IngestParams {
	accountId: string;
	folderRole: FolderRole;
	remoteName: string;
	remoteUid: number;
	remoteUidValidity: number;
	raw: Buffer;
	flags: Set<string>;
	/**
	 * Which loop produced this message. Forward IDLE/poll sync is `'sync'`;
	 * a historical import is `'backfill'`. The server enqueues the Reply Queue +
	 * category classification for `'sync'` inbox mail ONLY, so importing years of
	 * history never fans out background LLM work. The worker is the only party
	 * that knows which loop it is in, so it has to say so.
	 */
	origin: 'sync' | 'backfill';
}

/**
 * What the server did with one message. Mirrors `ExternalIngestOutcome` in
 * `apps/api/convex/mail/external/delivery.ts`.
 *
 * `duplicate` means the message is ALREADY in the mailbox (Gmail's "All Mail"
 * repeats every other folder), so it counts as landed; `no_target` means the
 * account/mailbox/folder it belongs in is gone and nothing was stored. Reading
 * this is what stops a walk that stored nothing from reporting a full import.
 */
export type IngestOutcome = { messageId: string } | { skipped: 'duplicate' | 'no_target' };

/** True when the message is in the mailbox now — stored by this call, or already there. */
export function isMessageLanded(outcome: IngestOutcome): boolean {
	return !('skipped' in outcome) || outcome.skipped === 'duplicate';
}

/**
 * Upload the raw `.eml` and return its Convex storage id.
 *
 * A plain byte body to an HTTP action, which has no 16 MiB function-call cap —
 * that cap is what used to drop every large message. A non-2xx answer throws,
 * so the caller counts the message as failed rather than ingesting a message
 * whose raw bytes were never stored.
 */
async function uploadRawMessage(
	config: RawUploadConfig,
	raw: Buffer
): Promise<{ storageId: string; size: number }> {
	const response = await fetch(`${config.convexSiteUrl}/mail-sync/raw-message`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			'Content-Type': 'message/rfc822',
		},
		body: new Uint8Array(raw),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new Error(`raw upload failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
	}
	return (await response.json()) as { storageId: string; size: number };
}

/** What `ingestMessage` needs to reach the raw-upload endpoint. */
export interface RawUploadConfig {
	convexSiteUrl: string;
	apiKey: string;
}

export async function ingestMessage(
	convex: ConvexClient,
	config: RawUploadConfig,
	params: IngestParams
): Promise<IngestOutcome> {
	const parsed = parseMessage(params.raw);
	const text = parsed.text ?? undefined;
	const html = typeof parsed.html === 'string' ? parsed.html : undefined;
	const attachments = parsed.attachments.map((a, i) => ({
		filename: a.filename.toWellFormed(),
		contentType: a.contentType.toWellFormed(),
		size: a.size,
		contentId: a.contentId?.toWellFormed(),
		partIndex: String(i),
	}));
	const references = Array.isArray(parsed.references)
		? parsed.references.join(' ')
		: (parsed.references ?? undefined);

	// Bytes first: a storage id the action can point at costs nothing in the
	// call's argument budget, however large the message is.
	const uploaded = await uploadRawMessage(config, params.raw);

	return (await convex.action(
		fn.ingestExternalRaw as never,
		{
			accountId: params.accountId,
			folderRole: params.folderRole,
			remoteName: params.remoteName.toWellFormed(),
			remoteUid: params.remoteUid,
			remoteUidValidity: params.remoteUidValidity,
			rawStorageId: uploaded.storageId,
			rawSize: uploaded.size,
			headerBlockBase64: params.raw.subarray(0, HEADER_BLOCK_BYTES).toString('base64'),
			from: primaryAddress(parsed.from),
			to: addrList(parsed.to),
			cc: addrList(parsed.cc),
			bcc: addrList(parsed.bcc),
			replyTo: addrText(parsed.replyTo),
			subject: parsed.subject?.toWellFormed() ?? '',
			textBodyInline: capBody(text),
			htmlBodyInline: capBody(html),
			messageId: parsed.messageId?.toWellFormed() ?? syntheticMessageId(params),
			inReplyTo: parsed.inReplyTo?.toWellFormed(),
			references: references?.toWellFormed(),
			receivedAt: (parsed.date ?? new Date()).getTime(),
			attachments,
			flagSeen: params.flags.has('\\Seen'),
			flagFlagged: params.flags.has('\\Flagged'),
			origin: params.origin,
		} as never
	)) as IngestOutcome;
}
