/**
 * The text model of "Share as image…": one message as a card of words (sender,
 * address, date, subject, body), each word a token the person can redact, and
 * the "Hide personal details" pass that picks the tokens to redact.
 *
 * The card holds text only. Images in the message are never part of it, so
 * rendering the card fetches nothing and the remote-image and tracker rules
 * have nothing to decide. The body is the fresh part of the message: the
 * quoted history under a reply is left out, as the reader folds it away.
 *
 * Pure, so the redaction rules are testable without a canvas.
 */
import { htmlToPlainText } from '@owlat/shared/html';
import { splitQuotedHtml, splitQuotedText } from '@owlat/shared/quotedText';

export type ShareCardField = 'sender' | 'address' | 'date' | 'subject' | 'body';

export interface ShareCardToken {
	/** Index into `ShareCard.tokens`; the redaction set holds these. */
	id: number;
	text: string;
}

/** One header field or the body: hard lines of tokens (an empty line is a paragraph gap). */
export interface ShareCardBlock {
	field: ShareCardField;
	lines: ShareCardToken[][];
}

export interface ShareCard {
	blocks: ShareCardBlock[];
	tokens: ShareCardToken[];
	/** The body was clipped to {@link SHARE_CARD_MAX_BODY_CHARS} / lines. */
	truncated: boolean;
}

/**
 * The longest body the card draws; past it the card ends in an ellipsis. A
 * canvas has a maximum size and Safari's is the smallest (about 16.7 million
 * pixels): at these limits the tallest card, wrapped and exported at twice its
 * size, stays under it instead of failing to export.
 */
export const SHARE_CARD_MAX_BODY_CHARS = 6000;
export const SHARE_CARD_MAX_BODY_LINES = 160;

export interface ShareCardInput {
	fromName?: string;
	fromAddress: string;
	/** Already formatted for the reader's locale. */
	date: string;
	subject: string;
	body: string;
}

/**
 * The body text the card shows: the HTML part reduced to text when there is one
 * (it is what the reader shows), the text part otherwise, without the quoted
 * history. A message that is all quote keeps it, or the card would be empty.
 */
export function shareCardBodyText(body: { html?: string | null; text?: string | null }): string {
	const html = body.html?.trim() ? body.html : '';
	if (html) {
		const fresh = htmlToPlainText(splitQuotedHtml(html).fresh).trim();
		return fresh || htmlToPlainText(html).trim();
	}
	const text = body.text ?? '';
	const fresh = splitQuotedText(text).fresh.trim();
	return fresh || text.trim();
}

/** Lines of the body, blank runs squeezed to one, clipped to the card's limits. */
function bodyLines(body: string): { lines: string[]; truncated: boolean } {
	let text = body.replace(/\r\n?/g, '\n');
	let truncated = false;
	if (text.length > SHARE_CARD_MAX_BODY_CHARS) {
		text = text.slice(0, SHARE_CARD_MAX_BODY_CHARS);
		truncated = true;
	}
	const lines: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
		lines.push(line);
	}
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	if (lines.length > SHARE_CARD_MAX_BODY_LINES) {
		lines.length = SHARE_CARD_MAX_BODY_LINES;
		truncated = true;
	}
	if (truncated) lines.push('…');
	return { lines, truncated };
}

export function buildShareCard(input: ShareCardInput): ShareCard {
	const tokens: ShareCardToken[] = [];
	const tokenize = (line: string): ShareCardToken[] =>
		line
			.split(/\s+/)
			.filter(Boolean)
			.map((text) => {
				const token = { id: tokens.length, text };
				tokens.push(token);
				return token;
			});
	const block = (field: ShareCardField, lines: string[]): ShareCardBlock => ({
		field,
		lines: lines.map(tokenize),
	});

	const blocks: ShareCardBlock[] = [];
	const fromName = input.fromName?.trim();
	if (fromName) blocks.push(block('sender', [fromName]));
	if (input.fromAddress.trim()) blocks.push(block('address', [input.fromAddress.trim()]));
	blocks.push(block('date', [input.date]));
	blocks.push(block('subject', [input.subject]));
	const body = bodyLines(input.body);
	blocks.push(block('body', body.lines));
	return { blocks, tokens, truncated: body.truncated };
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// A run of digits with the separators phone numbers are written with. The
// digit count below decides; a date is told apart by its shape. A run has no
// upper bound: two numbers written as "030 1234567 / 040 7654321" are one run,
// and it is hidden whole.
const PHONE_RUN = /\+?\(?\d[\d\s()./-]*\d/g;
const DATE_SHAPES = [/^\d{4}-\d{1,2}-\d{1,2}$/, /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/];
const MIN_PHONE_DIGITS = 7;

function isPhoneNumber(match: string): boolean {
	if (match.replace(/\D/g, '').length < MIN_PHONE_DIGITS) return false;
	const compact = match.replace(/\s/g, '');
	return !DATE_SHAPES.some((shape) => shape.test(compact));
}

/** A word without the punctuation around it, compared case-insensitively. */
function bareWord(text: string): string {
	return text
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
		.replace(/['’]s$/u, '')
		.toLocaleLowerCase();
}

/**
 * The tokens "Hide personal details" redacts: every email address, every phone
 * number and every word of the person's own name, anywhere on the card. The
 * date is left alone (its digits are not a phone number). It errs towards
 * redacting more: a long number that is not a phone number is hidden too, and
 * the person can click it back.
 */
export function personalDetailTokenIds(card: ShareCard, ownName?: string | null): Set<number> {
	const ids = new Set<number>();
	const nameParts = new Set(
		(ownName ?? '')
			.split(/\s+/)
			.map(bareWord)
			.filter((part) => part.length >= 2)
	);

	for (const block of card.blocks) {
		if (block.field === 'date') continue;
		for (const line of block.lines) {
			for (const token of line) {
				if (EMAIL.test(token.text) || nameParts.has(bareWord(token.text))) ids.add(token.id);
			}
			// A phone number can span tokens ("+49 30 1234567"): match on the
			// line as written and take every token the match touches.
			const starts: number[] = [];
			let joined = '';
			for (const token of line) {
				if (joined) joined += ' ';
				starts.push(joined.length);
				joined += token.text;
			}
			for (const match of joined.matchAll(PHONE_RUN)) {
				if (!isPhoneNumber(match[0])) continue;
				const from = match.index ?? 0;
				const to = from + match[0].length;
				for (const [i, token] of line.entries()) {
					const start = starts[i] ?? 0;
					if (start < to && start + token.text.length > from) ids.add(token.id);
				}
			}
		}
	}
	return ids;
}
