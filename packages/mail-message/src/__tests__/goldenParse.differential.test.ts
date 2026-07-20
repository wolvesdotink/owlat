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
import { simpleParser } from 'mailparser';
import { parseMessage, type ParsedHeaderValue } from '../parse/index';
import { GOLDEN_CASES, readGolden } from '../../__tests__/golden/goldens';
import { normBody, project, type ProjectOptions } from './helpers/projection';

/**
 * Enrichment (i): mailparser rewrites inline `<img src="cid:...">` in `.html` to
 * an embedded `data:` URI while `parseMessage` preserves the original `cid:`
 * reference. Collapse both forms to a placeholder so the `.html` bodies compare.
 * Layered on the shared P3 projection through the {@link ProjectOptions} hook so
 * this delta from the base differential is explicit and single-sourced.
 */
function collapseInlineImgSrc(s: string | false | undefined): string | false {
	if (s === false) return false;
	const collapsed = (s ?? '').replace(/src="(?:cid:|data:)[^"]*"/g, 'src="#img"');
	return normBody(collapsed);
}

/** `text/x-amp-html` is outbound-only with no inbound consumer — excluded both sides. */
const AMP_CONTENT_TYPE = 'text/x-amp-html';

/** The golden suite's sanctioned deltas over the base P3 projection (enrichment (i) + AMP). */
const GOLDEN_PROJECT_OPTIONS: ProjectOptions = {
	htmlNormalizer: collapseInlineImgSrc,
	excludeAttachmentContentTypes: [AMP_CONTENT_TYPE],
};

describe('parseMessage differential parity vs mailparser on the compose-side golden corpus', () => {
	for (const testCase of GOLDEN_CASES) {
		it(`matches mailparser on every consumed field: golden ${testCase.name}`, async () => {
			const raw = readGolden(testCase);
			const theirs = await simpleParser(raw);
			const ours = parseMessage(raw);

			const theirProjection = project(
				theirs,
				(name) => theirs.headers.get(name),
				GOLDEN_PROJECT_OPTIONS
			);
			const ourProjection = project(
				ours,
				(name: string): ParsedHeaderValue | undefined => ours.headers.get(name),
				GOLDEN_PROJECT_OPTIONS
			);

			// Enrichment (ii): mailparser synthesizes `.text` from `.html` when the
			// message carries NO `text/plain` part; our parser returns empty `.text`.
			// Gate the drop on GROUND TRUTH — the two corpus input shapes for which
			// `composeMessage` emits NO `text/plain` part (`text` absent OR the empty
			// string) — NOT on our own output, so a regression that empties `.text`
			// for a case that HAS a text part still fails. Assert the documented claim
			// (empty `.text` for a message with no text part) instead of copying the
			// SUT onto the oracle, so a fabricated non-empty `.text` cannot pass here.
			if (testCase.text === undefined || testCase.text === '') {
				expect(ourProjection['text'], 'no text/plain part on the wire').toBe('');
				theirProjection['text'] = '';
			}

			expect(ourProjection).toEqual(theirProjection);
		});
	}

	it('covers the full golden corpus (>= 40 signed inputs)', () => {
		expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(40);
	});
});
