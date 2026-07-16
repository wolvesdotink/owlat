/**
 * Parse a raw RFC822 message (in-house `@owlat/mail-message.parseMessage`) and
 * hand it to Convex for storage + insertion via the `ingestExternalRaw` action.
 * The worker holds the admin key but cannot mint storage upload URLs (those need
 * a user session), so it ships the raw bytes as base64 and Convex stores them
 * server-side.
 */

import { parseMessage, type AddressObject } from '@owlat/mail-message';
import type { ConvexClient } from './convex.js';
import { fn } from './convex.js';
import type { FolderRole } from './folders.js';

// Bodies ride alongside the base64 raw .eml in one action call; cap them so a
// pathological message can't blow Convex's per-call arg limit. Over-cap bodies
// are truncated to a byte-accurate prefix (rare; HTML email bodies are ~tens of
// KB) so the server still derives a usable snippet + preview; the full message
// is always preserved in the raw .eml blob regardless.
const WIRE_BODY_LIMIT = 1024 * 1024; // 1 MB

function capBody(body: string | undefined): string | undefined {
	if (!body) return undefined;
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
			if (v.address) out.push(v.address);
		}
	}
	return out;
}

/**
 * The single address of a `From:`-shaped field — the first parsed mailbox, or
 * `''` when the header is absent/address-less. `From:` is a single
 * {@link AddressObject}; the array arm only fires on a (malformed) repeated
 * header, in which case we read the first object, matching the old
 * `parsed.from?.value?.[0]?.address` extraction.
 */
function primaryAddress(field: AddressObject | AddressObject[] | undefined): string {
	const obj = Array.isArray(field) ? field[0] : field;
	return obj?.value[0]?.address ?? '';
}

/**
 * The display text of a `Reply-To:`-shaped field — the formatted address list
 * mailparser exposed as `.text`. A repeated header (array arm) joins each
 * object's text; an absent header yields `undefined`.
 */
function addrText(field: AddressObject | AddressObject[] | undefined): string | undefined {
	if (!field) return undefined;
	return Array.isArray(field) ? field.map((o) => o.text).join(', ') : field.text;
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
}

export async function ingestMessage(convex: ConvexClient, params: IngestParams): Promise<void> {
	const parsed = parseMessage(params.raw);
	const text = parsed.text ?? undefined;
	const html = typeof parsed.html === 'string' ? parsed.html : undefined;
	const attachments = parsed.attachments.map((a, i) => ({
		filename: a.filename,
		contentType: a.contentType,
		size: a.size,
		contentId: a.contentId ?? undefined,
		partIndex: String(i),
	}));
	const references = Array.isArray(parsed.references)
		? parsed.references.join(' ')
		: (parsed.references ?? undefined);

	await convex.action(
		fn.ingestExternalRaw as never,
		{
			accountId: params.accountId,
			folderRole: params.folderRole,
			remoteName: params.remoteName,
			remoteUid: params.remoteUid,
			remoteUidValidity: params.remoteUidValidity,
			rawBytesBase64: params.raw.toString('base64'),
			from: primaryAddress(parsed.from),
			to: addrList(parsed.to),
			cc: addrList(parsed.cc),
			bcc: addrList(parsed.bcc),
			replyTo: addrText(parsed.replyTo),
			subject: parsed.subject ?? '',
			textBodyInline: capBody(text),
			htmlBodyInline: capBody(html),
			messageId: parsed.messageId ?? syntheticMessageId(params),
			inReplyTo: parsed.inReplyTo ?? undefined,
			references,
			receivedAt: (parsed.date ?? new Date()).getTime(),
			attachments,
			flagSeen: params.flags.has('\\Seen'),
			flagFlagged: params.flags.has('\\Flagged'),
		} as never
	);
}
