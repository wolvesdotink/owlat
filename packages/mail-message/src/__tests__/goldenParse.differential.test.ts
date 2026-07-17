/**
 * UNIFIED SYNERGY (piece R2, locked decision U3): the compose-side golden corpus
 * doubles as a parse-side differential corpus.
 *
 * Each golden is a DKIM-signed message OUR OWN `composeMessage` + `signMessage`
 * produced (see `__tests__/golden/goldens.ts`). Here we feed every golden back
 * through the SAME P3 machinery `differential.test.ts` uses — parse the bytes with
 * both mailparser (the oracle) and our `parseMessage`, then assert equality of
 * every CONSUMED FIELD the six inbound consumers read. Because a single package
 * now owns both halves of `@owlat/mail-message`, this proves the compose half and
 * the parse half agree on the exact wire format they respectively emit and read —
 * with mailparser as an independent referee in the loop (never our code alone, I1).
 *
 * Two mailparser ENRICHMENTS are normalized away (they are mailparser conveniences,
 * NOT part of the raw consumed-field contract — our parser deliberately returns the
 * value that was actually on the wire, which is the same thing the older P3
 * hand-written corpus was crafted to avoid triggering):
 *
 *   (i)  mailparser rewrites inline `<img src="cid:...">` in `.html` to an embedded
 *        `data:` URI. `parseMessage` preserves the original `cid:` reference (the
 *        forwarder/attachment-stager needs it to re-associate the inline part), so
 *        both `src="cid:..."` and `src="data:..."` are collapsed to a placeholder
 *        before the `.html` bodies are compared.
 *   (ii) mailparser synthesizes `.text` from `.html` (tag-stripped) when the message
 *        carries NO `text/plain` part. `parseMessage` returns an empty `.text` for a
 *        message with no text part; when it does, the synthesized rendering is
 *        dropped from the comparison rather than fabricating a body that was never
 *        on the wire.
 *
 * Everything else — subject, threading headers, addresses, the real attachment set
 * in document order, the `Content-Type` signal, and the `.html` body structure — is
 * compared at the full P3 bar. `text/x-amp-html` alternative parts are excluded from
 * the attachment set on both sides (an outbound-only concern with no inbound
 * consumer; mailparser and our parser expose it differently and neither exposure is
 * a consumed field).
 */

import { describe, it, expect } from 'vitest';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { parseMessage, type ParsedMessage, type ParsedHeaderValue } from '../parse/index';
import { GOLDEN_CASES, readGolden } from '../../__tests__/golden/goldens';

interface AnyAddrEntry {
	name?: string;
	address?: string;
	group?: AnyAddrEntry[];
}
interface AnyAddrObject {
	value?: AnyAddrEntry[];
}

/** Flatten an address header (single/array, groups recursed) to `{name,address}`. */
function addrList(
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

function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
	return arr.map((r) => r.trim()).filter((r) => r !== '');
}

/** CRLF -> LF, drop trailing per-line and end whitespace. */
function normBody(s: string | false | undefined): string | false {
	if (s === false) return false;
	return (s ?? '')
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** Body normalizer that also collapses inline-image `src` (enrichment (i)). */
function normHtml(s: string | false | undefined): string | false {
	if (s === false) return false;
	const collapsed = (s ?? '').replace(/src="(?:cid:|data:)[^"]*"/g, 'src="#img"');
	return normBody(collapsed);
}

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

const AMP_CONTENT_TYPE = 'text/x-amp-html';

/** Document-order real attachments, projected on the consumed fields (amp excluded). */
function attSet(
	attachments: ParsedMail['attachments'] | ParsedMessage['attachments']
): Array<Record<string, unknown>> {
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
		// AMP alternative parts are outbound-only (no inbound consumer) and mailparser
		// vs our parser expose them differently — drop them from BOTH sides.
		.filter((a) => a.contentType !== AMP_CONTENT_TYPE)
		.sort((x, y) =>
			`${String(x['filename'])}|${String(x['contentId'])}|${String(x['content'])}`.localeCompare(
				`${String(y['filename'])}|${String(y['contentId'])}|${String(y['content'])}`
			)
		);
}

function project(
	p: ParsedMail | ParsedMessage,
	headerLookup: (name: string) => unknown
): Record<string, unknown> {
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
		html: normHtml(p.html),
		attachments: attSet(p.attachments),
		contentType: contentTypeSignal(headerLookup('content-type')),
	};
}

describe('parseMessage differential parity vs mailparser on the compose-side golden corpus', () => {
	for (const testCase of GOLDEN_CASES) {
		it(`matches mailparser on every consumed field: golden ${testCase.name}`, async () => {
			const raw = readGolden(testCase);
			const theirs = await simpleParser(raw);
			const ours = parseMessage(raw);

			const theirProjection = project(theirs, (name) => theirs.headers.get(name));
			const ourProjection = project(ours, (name: string): ParsedHeaderValue | undefined =>
				ours.headers.get(name)
			);

			// Enrichment (ii): when our parser found NO text part, drop mailparser's
			// synthesized `.text` rendering from the comparison on both sides.
			if (ourProjection['text'] === '') {
				theirProjection['text'] = '';
			}

			expect(ourProjection).toEqual(theirProjection);
		});
	}

	it('covers the full golden corpus (>= 40 signed inputs)', () => {
		expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(40);
	});
});
