/**
 * The SINGLE source of truth for the P3 consumed-field projection.
 *
 * Both parse-side differentials — the hand-written `differential.test.ts` corpus
 * and the compose-side `goldenParse.differential.test.ts` corpus — parse the same
 * bytes with mailparser (the oracle) and our `parseMessage`, then compare EVERY
 * CONSUMED FIELD the six inbound consumers read: subject, message-id /
 * in-reply-to (brackets kept), references (dual shape), date, the address headers
 * (name + address, groups recursed), text, the `html | false` sentinel, the
 * attachment set in DOCUMENT ORDER, and the structured `Content-Type` signal.
 *
 * Keeping the projection here — rather than copied into each suite — means a
 * future P3 projection fix reaches BOTH differentials and the base cannot drift.
 * The golden suite layers its two sanctioned normalizations on top through the
 * explicit {@link ProjectOptions} hooks, so its deltas from the base are visible
 * and single-sourced rather than a divergent copy.
 */

import type { AddressObject, ParsedMail } from 'mailparser';
import type { ParsedMessage } from '../../parse/index';

/** A generic address entry both mailparser and our parser expose on `.value`. */
export interface AnyAddrEntry {
	name?: string;
	address?: string;
	group?: AnyAddrEntry[];
}
export interface AnyAddrObject {
	value?: AnyAddrEntry[];
}

/**
 * Flatten an address header (single object or array, groups recursed) into a
 * comparable, order-preserving list of `{ name, address }`. Groups are recursed
 * symmetrically on both sides so a `Team: a@x, b@y;` header compares its members.
 */
export function addrList(
	field: AnyAddrObject | AnyAddrObject[] | AddressObject | AddressObject[] | undefined
): Array<{ name: string; address: string }> {
	if (field === undefined) return [];
	const objs = (Array.isArray(field) ? field : [field]) as AnyAddrObject[];
	const out: Array<{ name: string; address: string }> = [];
	const visit = (entries: AnyAddrEntry[] | undefined): void => {
		for (const entry of entries ?? []) {
			if (entry.group !== undefined) visit(entry.group);
			else out.push({ name: entry.name ?? '', address: (entry.address ?? '').toLowerCase() });
		}
	};
	for (const obj of objs) visit(obj.value);
	return out;
}

/** Normalize the dual `references`/`in-reply-to` shape to a comparable id list. */
export function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
	return arr.map((r) => r.trim()).filter((r) => r !== '');
}

/** Normalize a decoded body: CRLF -> LF, drop trailing per-line and end whitespace. */
export function normBody(s: string | false | undefined): string | false {
	if (s === false) return false;
	return (s ?? '')
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** The `Content-Type` signal the FBL / bounce classifiers consume: value + report-type. */
export function contentTypeSignal(raw: unknown): { value: string; reportType: string } {
	if (raw && typeof raw === 'object') {
		const obj = raw as { value?: unknown; params?: Record<string, unknown> };
		const value = typeof obj.value === 'string' ? obj.value.toLowerCase() : '';
		const reportType = String(obj.params?.['report-type'] ?? '').toLowerCase();
		return { value, reportType };
	}
	if (typeof raw === 'string') return { value: raw.toLowerCase(), reportType: '' };
	return { value: '', reportType: '' };
}

/**
 * The document-order attachment set, projected onto the consumed fields. Ordering
 * is a consumed field (partIndex feeds the Convex wire shape per W8/CI1) — the
 * list is NEVER sorted; a divergence in order is a real divergence and must fail.
 *
 * `excludeContentTypes` drops parts with the given (lowercased) content types from
 * BOTH sides before comparison — used only for the golden suite's sanctioned AMP
 * exclusion (`text/x-amp-html`, an outbound-only concern with no inbound consumer).
 */
export function attSet(
	attachments: ParsedMail['attachments'] | ParsedMessage['attachments'],
	excludeContentTypes: readonly string[] = []
): Array<Record<string, unknown>> {
	const excluded = new Set(excludeContentTypes.map((t) => t.toLowerCase()));
	return attachments
		.map((a) => ({
			filename: a.filename ?? '',
			contentType: a.contentType,
			contentId: (a.contentId ?? '').replace(/[<>]/g, ''),
			disposition:
				('disposition' in a ? a.disposition : (a.contentDisposition ?? 'attachment')) ??
				'attachment',
			size: a.size,
			content: a.content.toString('base64'),
		}))
		.filter((a) => !excluded.has(String(a.contentType).toLowerCase()));
}

/**
 * Optional, explicit deltas the golden suite layers on top of the base projection.
 * Each hook makes a sanctioned normalization visible instead of forking the base.
 */
export interface ProjectOptions {
	/** Replace the default `.html` normalizer (e.g. collapse inline-image `src`). */
	htmlNormalizer?: (s: string | false | undefined) => string | false;
	/** Content types to drop from the attachment set on both sides (lowercased). */
	excludeAttachmentContentTypes?: readonly string[];
}

/** The consumed-field projection two parses must agree on. */
export function project(
	p: ParsedMail | ParsedMessage,
	headerLookup: (name: string) => unknown,
	options: ProjectOptions = {}
): Record<string, unknown> {
	const htmlNormalizer = options.htmlNormalizer ?? normBody;
	return {
		subject: p.subject ?? '',
		messageId: p.messageId ?? '',
		inReplyTo: p.inReplyTo ?? '',
		references: refsList(p.references),
		date: p.date?.toISOString() ?? '',
		from: addrList(p.from as AnyAddrObject | AnyAddrObject[] | undefined),
		to: addrList(p.to as AnyAddrObject | AnyAddrObject[] | undefined),
		cc: addrList(p.cc as AnyAddrObject | AnyAddrObject[] | undefined),
		bcc: addrList(p.bcc as AnyAddrObject | AnyAddrObject[] | undefined),
		replyTo: addrList(p.replyTo as AnyAddrObject | AnyAddrObject[] | undefined),
		text: normBody(p.text),
		html: htmlNormalizer(p.html),
		attachments: attSet(p.attachments, options.excludeAttachmentContentTypes),
		contentType: contentTypeSignal(headerLookup('content-type')),
	};
}
