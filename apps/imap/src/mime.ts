/**
 * Minimal RFC 5322 header extractor for APPEND.
 *
 * APPEND'd messages are well-formed MIME from real clients (Apple Mail,
 * Thunderbird, Gmail, …). We only need enough envelope detail to pre-fill
 * the mailMessages row — the raw .eml stays the source of truth so any
 * header we miss can be re-derived later. Header splitting and unfolding
 * come from `@owlat/mail-message`; address parsing is shared with
 * MTA/contentScreening via `@owlat/shared`.
 */

import { parseHeaders } from '@owlat/mail-message';
import { parseAddressList, type ParsedAddress } from '@owlat/shared';
import { decodeEncodedWords as decodeMime } from '@owlat/shared/mailMime';

export interface ParsedAppendHeaders {
	messageId: string;
	subject: string;
	from: ParsedAddress;
	to: ParsedAddress[];
	cc: ParsedAddress[];
	bcc: ParsedAddress[];
	internalDate?: number;
	textBody?: string;
}

/** Split raw bytes into header block + body. Tolerates LF-only line endings. */
function splitHeadersAndBody(raw: string): { headers: string; body: string } {
	const sep = raw.match(/\r?\n\r?\n/);
	if (!sep) return { headers: raw, body: '' };
	const idx = sep.index ?? 0;
	return {
		headers: raw.slice(0, idx),
		body: raw.slice(idx + sep[0].length),
	};
}

function stripBrackets(s: string): string {
	return s.replace(/[<>]/g, '').trim();
}

export function parseAppendHeaders(rawBytes: Buffer): ParsedAppendHeaders {
	const text = rawBytes.toString('utf-8');
	const { headers: headerBlock, body } = splitHeadersAndBody(text);
	const headers = parseHeaders(headerBlock);

	const subject = decodeMime(headers.get('Subject') ?? '(no subject)');
	const messageIdRaw = headers.get('Message-ID') ?? '';
	const messageId =
		stripBrackets(messageIdRaw) ||
		`append-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const fromList = parseAddressList(decodeMime(headers.get('From') ?? ''));
	const toList = parseAddressList(decodeMime(headers.get('To') ?? ''));
	const ccList = parseAddressList(decodeMime(headers.get('Cc') ?? ''));
	const bccList = parseAddressList(decodeMime(headers.get('Bcc') ?? ''));
	const dateHeader = headers.get('Date');
	const internalDate = dateHeader ? Date.parse(dateHeader) : undefined;

	// Snippet/text body — for multipart bodies this will be the first part's
	// raw bytes which is good enough for list views. Real parsing happens on
	// FETCH BODY[].
	const text7 = body.slice(0, 4096);
	const textBody = text7
		.replace(/\r/g, '')
		.replace(/^.*?\n\n/s, '')
		.slice(0, 1000);

	return {
		messageId,
		subject,
		from: fromList[0] ?? { address: 'unknown@unknown' },
		to: toList,
		cc: ccList,
		bcc: bccList,
		internalDate: internalDate && !Number.isNaN(internalDate) ? internalDate : undefined,
		textBody,
	};
}

export function buildSnippet(text: string | undefined): string {
	if (!text) return '';
	return text
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}
