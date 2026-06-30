/**
 * Parse a raw RFC822 message (mailparser) and hand it to Convex for storage +
 * insertion via the `ingestExternalRaw` action. The worker holds the admin key
 * but cannot mint storage upload URLs (those need a user session), so it ships
 * the raw bytes as base64 and Convex stores them server-side.
 */

import { simpleParser, type AddressObject } from 'mailparser';
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
	const parsed = await simpleParser(params.raw);
	const text = parsed.text ?? undefined;
	const html = typeof parsed.html === 'string' ? parsed.html : undefined;
	const attachments = (parsed.attachments ?? []).map((a, i) => ({
		filename: a.filename ?? `attachment-${i + 1}`,
		contentType: a.contentType ?? 'application/octet-stream',
		size: a.size ?? 0,
		contentId: a.contentId ?? undefined,
		partIndex: String(i),
	}));
	const references = Array.isArray(parsed.references)
		? parsed.references.join(' ')
		: parsed.references ?? undefined;

	await convex.action(fn.ingestExternalRaw as never, {
		accountId: params.accountId,
		folderRole: params.folderRole,
		remoteName: params.remoteName,
		remoteUid: params.remoteUid,
		remoteUidValidity: params.remoteUidValidity,
		rawBytesBase64: params.raw.toString('base64'),
		from: parsed.from?.text ?? '',
		to: addrList(parsed.to),
		cc: addrList(parsed.cc),
		bcc: addrList(parsed.bcc),
		replyTo: parsed.replyTo?.text ?? undefined,
		subject: parsed.subject ?? '',
		textBodyInline: capBody(text),
		htmlBodyInline: capBody(html),
		messageId: parsed.messageId ?? `<${params.remoteUid}.${Date.now()}@owlat-mail-sync>`,
		inReplyTo: parsed.inReplyTo ?? undefined,
		references,
		receivedAt: (parsed.date ?? new Date()).getTime(),
		attachments,
		flagSeen: params.flags.has('\\Seen'),
		flagFlagged: params.flags.has('\\Flagged'),
	} as never);
}
