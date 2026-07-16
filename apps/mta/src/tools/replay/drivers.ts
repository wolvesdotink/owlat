/**
 * Driver projection for the inbound shadow-replay harness (piece C0).
 *
 * Projects a parsed message (from EITHER stack) onto the ROUTING / DELIVERY
 * DRIVERS the six inbound consumers actually read (parsed fields), with every
 * body / attachment payload reduced to a SHA-256 digest + length BEFORE it
 * enters a {@link RoutingDrivers} record. No decoded body text ever reaches a
 * divergence record, the formatted report or the JSON divergence log (I7).
 */

import { createHash } from 'node:crypto';

/** One address entry the routing consumers read: display name + address. */
export interface DriverAddress {
	readonly name: string;
	readonly address: string;
}

/** An attachment projected onto its routing fields — payload is a digest only. */
export interface DriverAttachment {
	readonly filename: string;
	readonly contentType: string;
	readonly contentId: string;
	readonly disposition: string;
	readonly size: number;
	/** SHA-256 of the decoded payload — NEVER the payload itself (I7). */
	readonly contentSha256: string;
}

/** A body part reduced to a digest — the text is never retained (I7). */
export interface DriverBody {
	readonly present: boolean;
	readonly length: number;
	/** SHA-256 of the normalized body text, or `''` when absent. */
	readonly sha256: string;
}

/**
 * The routing / delivery drivers the six inbound consumers (mail-sync ingest,
 * the bounce parser / FBL processor / route resolver / attachment stager, and
 * the inbound forwarder) read off a parsed message. Two stacks must agree on
 * EVERY field here.
 */
export interface RoutingDrivers {
	readonly subject: string;
	readonly messageId: string;
	readonly inReplyTo: string;
	readonly references: readonly string[];
	readonly date: string;
	readonly from: readonly DriverAddress[];
	readonly to: readonly DriverAddress[];
	readonly cc: readonly DriverAddress[];
	readonly bcc: readonly DriverAddress[];
	readonly replyTo: readonly DriverAddress[];
	readonly text: DriverBody;
	readonly html: DriverBody;
	readonly attachments: readonly DriverAttachment[];
	readonly contentType: { readonly value: string; readonly reportType: string };
}

/** A structural address entry both stacks expose on `.value` (groups recurse). */
interface AddrEntryLike {
	readonly name?: string;
	readonly address?: string;
	readonly group?: readonly AddrEntryLike[];
}
interface AddrObjectLike {
	readonly value?: readonly AddrEntryLike[];
}

/** A structural attachment both stacks expose (mailparser + our parser). */
interface AttachmentLike {
	readonly filename?: string;
	readonly contentType?: string;
	readonly contentId?: string;
	readonly disposition?: string;
	readonly contentDisposition?: string;
	readonly size?: number;
	readonly content: Buffer | Uint8Array;
}

/** The subset of a parsed message the projection reads (mailparser ∩ ours). */
export interface ParsedLike {
	readonly subject?: string;
	readonly messageId?: string;
	readonly inReplyTo?: string;
	readonly references?: string | string[];
	readonly date?: Date;
	readonly from?: unknown;
	readonly to?: unknown;
	readonly cc?: unknown;
	readonly bcc?: unknown;
	readonly replyTo?: unknown;
	readonly text?: string;
	readonly html?: string | false;
	readonly attachments: readonly AttachmentLike[];
}

/** Header lookup used only for the structured `Content-Type` signal. */
export type HeaderLookup = (name: string) => unknown;

function sha256hex(input: Buffer | string): string {
	return createHash('sha256').update(input).digest('hex');
}

/** Flatten an address header (single/array, groups recursed) into an ordered list. */
function addrList(field: unknown): DriverAddress[] {
	if (field === undefined || field === null) return [];
	const objs = (Array.isArray(field) ? field : [field]) as AddrObjectLike[];
	const out: DriverAddress[] = [];
	const visit = (entries: readonly AddrEntryLike[] | undefined): void => {
		for (const entry of entries ?? []) {
			if (entry.group !== undefined) {
				visit(entry.group);
			} else {
				out.push({ name: entry.name ?? '', address: (entry.address ?? '').toLowerCase() });
			}
		}
	};
	for (const obj of objs) {
		if (obj && typeof obj === 'object') visit(obj.value);
	}
	return out;
}

/** Normalize the dual `references` / `in-reply-to` shape into an id list. */
function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
	return arr.map((r) => r.trim()).filter((r) => r !== '');
}

/** CRLF -> LF, drop trailing per-line and end whitespace (line-ending agnostic). */
function normBodyText(s: string): string {
	return s
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** Reduce a body to a digest — the text is hashed, never retained (I7). */
function bodyDigest(s: string | false | undefined): DriverBody {
	if (s === false || s === undefined) return { present: false, length: 0, sha256: '' };
	const norm = normBodyText(s);
	return { present: true, length: norm.length, sha256: sha256hex(norm) };
}

/** The `Content-Type` signal the FBL / bounce classifiers consume: value + report-type. */
function contentTypeSignal(raw: unknown): { value: string; reportType: string } {
	if (raw && typeof raw === 'object') {
		const obj = raw as { value?: unknown; params?: Record<string, unknown> };
		const value = typeof obj.value === 'string' ? obj.value.toLowerCase() : '';
		const reportType = String(obj.params?.['report-type'] ?? '').toLowerCase();
		return { value, reportType };
	}
	if (typeof raw === 'string') return { value: raw.toLowerCase(), reportType: '' };
	return { value: '', reportType: '' };
}

/** Project the attachment set onto its routing fields — payloads become digests. */
function attList(attachments: readonly AttachmentLike[]): DriverAttachment[] {
	return attachments.map((a) => {
		const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
		const disposition = a.disposition ?? a.contentDisposition ?? 'attachment';
		return {
			filename: a.filename ?? '',
			contentType: a.contentType ?? '',
			contentId: (a.contentId ?? '').replace(/[<>]/g, ''),
			disposition,
			size: a.size ?? content.length,
			contentSha256: sha256hex(content),
		};
	});
}

/**
 * Project a parsed message (from EITHER stack) onto the routing / delivery
 * drivers. Bodies and attachment payloads are reduced to SHA-256 digests, so a
 * {@link RoutingDrivers} value can be logged, diffed and serialized without ever
 * exposing decoded body text (I7).
 */
export function projectDrivers(parsed: ParsedLike, headerLookup: HeaderLookup): RoutingDrivers {
	return {
		subject: parsed.subject ?? '',
		messageId: parsed.messageId ?? '',
		inReplyTo: parsed.inReplyTo ?? '',
		references: refsList(parsed.references),
		date: parsed.date?.toISOString() ?? '',
		from: addrList(parsed.from),
		to: addrList(parsed.to),
		cc: addrList(parsed.cc),
		bcc: addrList(parsed.bcc),
		replyTo: addrList(parsed.replyTo),
		text: bodyDigest(parsed.text),
		html: bodyDigest(parsed.html),
		attachments: attList(parsed.attachments),
		contentType: contentTypeSignal(headerLookup('content-type')),
	};
}
