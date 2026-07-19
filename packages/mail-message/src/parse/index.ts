/**
 * `parseMessage` — the inbound facade that assembles the FULL consumed-field
 * contract our mail path reads off mailparser today, so the six inbound
 * consumers (mail-sync ingest, the bounce parser / FBL processor / route
 * resolver / attachment stager, and the inbound forwarder) can switch from
 * `simpleParser(raw)` to `parseMessage(raw)` without changing a line of the
 * fields they touch.
 *
 * The facade is a thin assembly over the already-reviewed parse primitives
 * (`headers`, `contentType`, `date`, `address`, `body`, `attachments`); it adds
 * NO new parsing logic. The differential harness pins every consumed field to
 * mailparser; the drop-in typecheck proof pins the SHAPE to the bounce
 * pipeline's partial `ParsedMail` mocks.
 */

import { parseStructuredHeader, type StructuredHeader, type MessageHeaders } from './headers';
import { parseDate } from './date';
import { parseAddressObject, parseAddressObjects, type AddressObject } from './address';
import { parseMimeTree, assembleBody } from './body';
import { extractAttachmentsFromTree, type MessageAttachment } from './attachments';

export type { AddressObject, EmailAddress } from './address';
export type { MessageAttachment } from './attachments';
export type { StructuredHeader } from './headers';

/**
 * One value in the {@link ParsedMessage.headers} multimap. Mirrors the shapes
 * mailparser stores: structured `Content-Type`/`Content-Disposition`
 * (`{ value, params }`), parsed address headers, a `Date` for `Date:`, and a
 * plain (or repeated → array) string for everything else. Consumers that copy
 * headers forward take ONLY the `typeof value === 'string'` entries; the
 * structured entries are read through the top-level fields instead.
 */
export type ParsedHeaderValue =
	| string
	| string[]
	| StructuredHeader
	| AddressObject
	| AddressObject[]
	| Date;

/**
 * The parsed representation of an RFC 822 message — the consumed-field contract
 * that replaces mailparser's `ParsedMail` on Owlat's inbound path.
 *
 * `messageId` / `inReplyTo` KEEP their surrounding angle brackets (consumers
 * strip). `references` is the dual `string | string[]` shape (a single id is a
 * string; multiple are an array). `date` is `undefined` for an
 * absent/unparseable `Date:` — never an `Invalid Date`. `html` carries the
 * load-bearing `false` sentinel when the message has no HTML part.
 */
export interface ParsedMessage {
	/** Decoded `Subject:` (RFC 2047), or `undefined` when absent. */
	subject: string | undefined;
	/** `Message-ID` WITH angle brackets, or `undefined`. */
	messageId: string | undefined;
	/** `In-Reply-To` WITH angle brackets, or `undefined`. */
	inReplyTo: string | undefined;
	/** `References` as a single id, a list of ids, or `undefined`. */
	references: string | string[] | undefined;
	/** Parsed `Date:`, or `undefined` when absent/unparseable. */
	date: Date | undefined;
	/**
	 * Parsed `From:` — always a single object (a repeated header collapses to the
	 * LAST instance, matching mailparser's `singleKeys`), or `undefined`.
	 */
	from: AddressObject | AddressObject[] | undefined;
	/**
	 * Unfolded raw RFC5322.From values before permissive address recovery. DMARC
	 * uses these to require one syntactically valid mailbox identity.
	 */
	rawFrom: readonly string[];
	/** Parsed `To:`; an array when the header is repeated. */
	to: AddressObject | AddressObject[] | undefined;
	/** Parsed `Cc:`; an array when the header is repeated. */
	cc: AddressObject | AddressObject[] | undefined;
	/** Parsed `Bcc:`; an array when the header is repeated. */
	bcc: AddressObject | AddressObject[] | undefined;
	/**
	 * Parsed `Reply-To:` — always a single object (a repeated header collapses to
	 * the LAST instance, matching mailparser's `singleKeys`), or `undefined`.
	 */
	replyTo: AddressObject | AddressObject[] | undefined;
	/** Concatenated `text/plain` body, or `undefined` when there is none. */
	text: string | undefined;
	/** Concatenated `text/html` body, or the `false` sentinel when absent. */
	html: string | false;
	/**
	 * Case-insensitive header multimap. `Content-Type`/`Content-Disposition` are
	 * structured `{ value, params }`; address headers are {@link AddressObject}s;
	 * `Date:` is a `Date`; everything else is a `string` (or `string[]` when the
	 * header repeats).
	 */
	headers: Map<string, ParsedHeaderValue>;
	/**
	 * Raw top-level header occurrence counts before mailparser-compatible
	 * single-value collapsing. Security consumers use this to reject malformed
	 * repeated singleton headers (notably DMARC's RFC5322.From identifier) while
	 * display/ingest consumers retain the legacy collapsed field shape.
	 */
	headerCounts: ReadonlyMap<string, number>;
	/** Attachment leaves in DOCUMENT ORDER (the `partIndex === String(i)` contract). */
	attachments: MessageAttachment[];
}

/** Header names mailparser parses as address lists — stored structured in `headers`. */
const ADDRESS_HEADERS = new Set([
	'from',
	'to',
	'cc',
	'bcc',
	'sender',
	'reply-to',
	'delivered-to',
	'return-path',
]);

/**
 * Address headers mailparser treats as `singleKeys` — a repeated occurrence
 * collapses to the LAST instance (`mail-parser.js`: `headers.set(key, value[value.length - 1])`).
 * `from`/`sender`/`reply-to`/`return-path` are single-valued by RFC 5322; the
 * remaining address headers (`to`/`cc`/`bcc`/`delivered-to`) accumulate every
 * occurrence. We mirror that split so `parseMessage(raw)` matches `simpleParser(raw)`
 * on a (malformed) repeated `From:`/`Reply-To:` instead of exposing an array the
 * oracle never produced.
 */
const SINGLE_ADDRESS_HEADERS = new Set(['from', 'sender', 'reply-to', 'return-path']);

/**
 * The header values to parse for an address field: the LAST occurrence only for
 * mailparser's single-valued keys, every occurrence otherwise.
 */
function addressValues(headers: MessageHeaders, name: string): string[] {
	if (SINGLE_ADDRESS_HEADERS.has(name)) {
		const last = headers.last(name);
		return last === undefined ? [] : [last];
	}
	return headers.getAll(name);
}

/** Header names stored as structured `{ value, params }` in `headers`. */
const STRUCTURED_HEADERS = new Set(['content-type', 'content-disposition']);

/** Parse a `References:`/`In-Reply-To:` value into the dual `string | string[]` shape. */
function parseReferences(raw: string): string | string[] | undefined {
	const trimmed = raw.trim();
	if (trimmed === '') return undefined;
	const angled = trimmed.match(/<[^<>]*>/g);
	const list = angled && angled.length > 0 ? angled : trimmed.split(/\s+/).filter((t) => t !== '');
	if (list.length === 0) return undefined;
	return list.length === 1 ? list[0]! : list;
}

/**
 * Parse a raw RFC 822 message into the {@link ParsedMessage} consumed-field
 * contract. `raw` may be a `Buffer` (decoded as latin1 — one char per byte, the
 * binary-string convention the MIME walker expects) or an already-binary
 * string.
 */
export function parseMessage(raw: string | Buffer): ParsedMessage {
	const binary = typeof raw === 'string' ? raw : raw.toString('latin1');
	const tree = parseMimeTree(binary);
	const headers = tree.headers;
	const body = assembleBody(tree);

	const refsRaw = headers.getAll('references').join(' ');
	// mailparser collapses these single-valued display headers to the LAST
	// occurrence (its `singleKeys` + `map.set`); a header-shadowing message must
	// resolve identically here, mirroring the address-header split above.
	const inReplyToRaw = headers.last('in-reply-to');

	const structured = new Map<string, ParsedHeaderValue>();
	const headerCounts = new Map<string, number>();
	for (const name of headers.names()) {
		headerCounts.set(name, headers.getAll(name).length);
		if (ADDRESS_HEADERS.has(name)) {
			const value = parseAddressObjects(addressValues(headers, name));
			if (value !== undefined) structured.set(name, value);
			continue;
		}
		if (STRUCTURED_HEADERS.has(name)) {
			structured.set(name, parseStructuredHeader(headers.last(name)));
			continue;
		}
		if (name === 'date') {
			// Single-valued: mailparser collapses a duplicated Date to the last.
			const raw = headers.last(name);
			structured.set(name, parseDate(raw) ?? raw ?? '');
			continue;
		}
		const all = headers.getAll(name);
		structured.set(name, all.length > 1 ? all : (all[0] ?? ''));
	}

	return {
		subject: headers.lastDecoded('subject'),
		messageId: headers.last('message-id'),
		inReplyTo: inReplyToRaw,
		references: parseReferences(refsRaw),
		date: parseDate(headers.last('date')),
		from: parseAddressObjects(addressValues(headers, 'from')),
		rawFrom: headers.getAll('from'),
		to: parseAddressObjects(addressValues(headers, 'to')),
		cc: parseAddressObjects(addressValues(headers, 'cc')),
		bcc: parseAddressObjects(addressValues(headers, 'bcc')),
		replyTo: parseAddressObjects(addressValues(headers, 'reply-to')),
		text: body.text,
		html: body.html,
		headers: structured,
		headerCounts,
		attachments: extractAttachmentsFromTree(tree),
	};
}

/** Re-export the single-header address parser for callers assembling one field. */
export { parseAddressObject };
