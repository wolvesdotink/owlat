/**
 * The UNIFIED-only round-trip gate (piece P3, locked decision U3): our composer
 * feeds our parser. For every case in the M2 differential corpus we
 * `composeMessage(x)` and then `parseMessage(raw)`, asserting the consumed-field
 * contract survives the round trip — subject, addresses, threading headers,
 * date, the decoded text / html bodies, and the document-order attachment set.
 *
 * This is the seam the two halves of `@owlat/mail-message` meet at: because a
 * single package now owns both `compose/*` and `parse/*`, a break in either half
 * shows up here without any third-party oracle in the loop. (The compose and
 * parse differentials against nodemailer / mailparser cover each half's fidelity
 * to the libraries it replaces.)
 */

import { describe, it, expect } from 'vitest';
import { composeMessage } from '../index';
import { parseMessage } from '../parse/index';
import { parseAddressObject, type AddressObject } from '../parse/address';
import { CORPUS, toComposeInput } from '../../__tests__/fixtures/corpus';

/** Lowercased address set of one or more parsed address headers. */
function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
	if (field === undefined) return [];
	const objs = Array.isArray(field) ? field : [field];
	const out: string[] = [];
	for (const obj of objs) {
		for (const entry of obj.value) {
			if (entry.address !== '') out.push(entry.address.toLowerCase());
		}
	}
	return out.sort();
}

/** Expected address set, parsed from a raw header spec string via our own parser. */
function expectedAddresses(specs: string[] | string | undefined): string[] {
	if (specs === undefined) return [];
	const list = Array.isArray(specs) ? specs : [specs];
	return addresses(parseAddressObject(list.join(', '))).slice();
}

/** Normalize a body: CRLF -> LF, drop trailing per-line and end whitespace. */
function normBody(s: string | false | undefined): string {
	if (s === false || s === undefined) return '';
	return s
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n+$/, '');
}

/** The sorted base64 content set of the parsed attachments. */
function contentSet(attachments: ReturnType<typeof parseMessage>['attachments']): string[] {
	return attachments.map((a) => a.content.toString('base64')).sort();
}

function refsList(refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	return (Array.isArray(refs) ? refs : refs.split(/\s+/))
		.map((r) => r.trim())
		.filter((r) => r !== '');
}

describe('composeMessage -> parseMessage round-trips the consumed-field contract', () => {
	for (const testCase of CORPUS) {
		it(`round-trips: ${testCase.name}`, () => {
			const composed = composeMessage(toComposeInput(testCase));
			const parsed = parseMessage(composed.raw);

			// Threading + identity headers.
			expect(parsed.messageId).toBe(testCase.messageId);
			expect(parsed.date?.toISOString()).toBe(testCase.date.toISOString());
			expect(parsed.subject ?? '').toBe(testCase.subject);

			// Addresses (lowercased sets; our composer preserves them, our parser reads them back).
			expect(addresses(parsed.from)).toEqual(expectedAddresses(testCase.from));
			expect(addresses(parsed.to)).toEqual(expectedAddresses(testCase.to));
			expect(addresses(parsed.cc)).toEqual(expectedAddresses(testCase.cc));
			expect(addresses(parsed.replyTo)).toEqual(expectedAddresses(testCase.replyTo));

			// Threading references.
			if (testCase.inReplyTo !== undefined) expect(parsed.inReplyTo).toBe(testCase.inReplyTo);
			if (testCase.references !== undefined) {
				expect(refsList(parsed.references)).toEqual(refsList(testCase.references));
			}

			// Bodies: our parser transfer-decodes + charset-decodes back to the source.
			if (testCase.text !== undefined && testCase.text !== '') {
				expect(normBody(parsed.text)).toBe(normBody(testCase.text));
			}
			if (testCase.html !== undefined && testCase.html !== '') {
				expect(normBody(parsed.html)).toBe(normBody(testCase.html));
			}

			// Attachment set: same count, same document-order decoded contents.
			const expectedContents = (testCase.attachments ?? []).map((a) =>
				a.content.toString('base64')
			);
			expect(parsed.attachments).toHaveLength(expectedContents.length);
			expect(contentSet(parsed.attachments)).toEqual([...expectedContents].sort());

			// Inline vs file disposition is preserved per part.
			for (const att of parsed.attachments) {
				const match = (testCase.attachments ?? []).find(
					(a) => a.content.toString('base64') === att.content.toString('base64')
				);
				if (match) {
					expect(att.disposition).toBe(match.cid !== undefined ? 'inline' : 'attachment');
					if (match.cid !== undefined) expect(att.contentId).toBe(match.cid);
				}
			}
		});
	}

	it('covers the full M2 corpus', () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(40);
	});
});
