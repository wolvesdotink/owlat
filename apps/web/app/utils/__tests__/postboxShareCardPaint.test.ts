/**
 * The redaction guarantee of "Share as image…": a redacted word's glyphs are
 * never drawn, so the exported PNG cannot contain it. The canvas here records
 * every call the paint makes; whatever reaches the real canvas reaches this
 * one, so a redacted word that is absent here is absent from the image.
 */
import { describe, it, expect } from 'vitest';
import { buildShareCard, personalDetailTokenIds } from '../postboxShareCard';
import {
	SHARE_CARD_THEMES,
	SHARE_CARD_WIDTH,
	layoutShareCard,
	paintShareCard,
	redactionBox,
	shareCardTokenAt,
	type ShareCardCanvas,
	type ShareCardPaintOptions,
	type ShareCardRedactionStyle,
	type ShareCardScheme,
} from '../postboxShareCardPaint';

type Call =
	| { op: 'fillText'; text: string; x: number; y: number }
	| { op: 'fillRect'; x: number; y: number; w: number; h: number; fill: string };

function recordingCanvas(): ShareCardCanvas & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fillStyle: '',
		font: '',
		textBaseline: 'alphabetic',
		filter: 'none',
		setTransform() {},
		fillRect(x, y, w, h) {
			calls.push({ op: 'fillRect', x, y, w, h, fill: String(this.fillStyle) });
		},
		fillText(text, x, y) {
			calls.push({ op: 'fillText', text, x, y });
		},
	};
}

// Monospaced stand-in for measureText: 8px a character.
const measure = (text: string) => Array.from(text).length * 8;

const SECRET = 'Sesame-4471';
const message = {
	fromName: 'Ben Ortiz',
	fromAddress: 'ben@acmecorp.example',
	date: 'Nov 3, 2026, 08:21',
	subject: `Your code ${SECRET}`,
	body: `Hello,\n\nthe door code is ${SECRET} and my number is +31 20 5550100.\n\nBen`,
};

function paint(
	redacted: ReadonlySet<number>,
	options: Partial<ShareCardPaintOptions> = {},
	input = message
) {
	const card = buildShareCard(input);
	const layout = layoutShareCard(card, measure, 'Figtree');
	const ctx = recordingCanvas();
	paintShareCard(ctx, layout, { redacted, style: 'bar', scheme: 'light', scale: 2, ...options });
	return { card, layout, ctx };
}

const drawnText = (calls: Call[]) =>
	calls.flatMap((call) => (call.op === 'fillText' ? [call.text] : [])).join(' ');

function idsOf(text: string) {
	const card = buildShareCard(message);
	return new Set(card.tokens.filter((token) => token.text.includes(text)).map((t) => t.id));
}

describe('paintShareCard', () => {
	it('draws every word when nothing is redacted', () => {
		const text = drawnText(paint(new Set()).ctx.calls);
		expect(text).toContain(SECRET);
		expect(text).toContain('ben@acmecorp.example');
	});

	const variants: Array<[ShareCardRedactionStyle, ShareCardScheme]> = [
		['bar', 'light'],
		['bar', 'dark'],
		['blur', 'light'],
		['blur', 'dark'],
	];
	it.each(variants)('never draws a redacted word (%s, %s card)', (style, scheme) => {
		const { ctx } = paint(idsOf(SECRET), { style, scheme });
		const text = drawnText(ctx.calls);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain('Sesame');
		expect(text).not.toContain('4471');
		// The rest of the card is still there.
		expect(text).toContain('door code is');
	});

	it('fills the place of a redacted word with an opaque bar', () => {
		const { layout, ctx } = paint(idsOf(SECRET));
		const secretFragments = layout.fragments.filter((f) => f.text === SECRET);
		expect(secretFragments).toHaveLength(2);
		for (const fragment of secretFragments) {
			const box = redactionBox(fragment);
			expect(ctx.calls).toContainEqual({
				op: 'fillRect',
				x: box.x,
				y: box.y,
				w: box.width,
				h: box.height,
				fill: SHARE_CARD_THEMES.light.bar,
			});
		}
	});

	it('starts every paint from an opaque background over the whole card', () => {
		const { layout, ctx } = paint(idsOf(SECRET), { scheme: 'dark' });
		expect(ctx.calls[0]).toEqual({
			op: 'fillRect',
			x: 0,
			y: 0,
			w: SHARE_CARD_WIDTH,
			h: layout.height,
			fill: SHARE_CARD_THEMES.dark.background,
		});
	});

	it('uses only opaque colours, so nothing under a redaction can show through', () => {
		for (const theme of Object.values(SHARE_CARD_THEMES)) {
			for (const colour of Object.values(theme)) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it('hides every personal detail the one-step pass picks', () => {
		const card = buildShareCard(message);
		const { ctx } = paint(personalDetailTokenIds(card, 'Ben Ortiz'));
		const text = drawnText(ctx.calls);
		for (const hidden of ['ben@acmecorp.example', '5550100', '+31', 'Ben', 'Ortiz']) {
			expect(text).not.toContain(hidden);
		}
		expect(text).toContain('door code is');
	});

	it('hides every piece of a word too long for one line', () => {
		const url = `https://example.com/${'x'.repeat(150)}`;
		const input = { ...message, body: `see ${url} now` };
		const card = buildShareCard(input);
		const id = card.tokens.find((token) => token.text === url)?.id ?? -1;
		const { layout, ctx } = paint(new Set([id]), {}, input);
		const pieces = layout.fragments.filter((f) => f.tokenId === id);
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.map((piece) => piece.text).join('')).toBe(url);
		const text = drawnText(ctx.calls);
		expect(text).not.toContain('example.com');
		expect(text).not.toContain('xxxx');
		expect(text).toContain('see');
	});

	it('joins two redacted neighbours into one bar across the space', () => {
		const input = { ...message, body: 'call 555 0100 now' };
		const card = buildShareCard(input);
		const ids = new Set(
			card.tokens.filter((t) => t.text === '555' || t.text === '0100').map((t) => t.id)
		);
		const { layout, ctx } = paint(ids, {}, input);
		const first = layout.fragments.find((f) => f.text === '555');
		const second = layout.fragments.find((f) => f.text === '0100');
		if (!first || !second) throw new Error('fragments missing');
		const bar = ctx.calls.find(
			(call) =>
				call.op === 'fillRect' && call.x === first.x && call.fill === SHARE_CARD_THEMES.light.bar
		);
		expect(bar).toMatchObject({ w: second.x - first.x });
	});
});

describe('layoutShareCard', () => {
	it('keeps every line inside the card', () => {
		const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
		const { layout } = paint(new Set(), {}, { ...message, body: words });
		for (const fragment of layout.fragments) {
			expect(fragment.x).toBeGreaterThanOrEqual(40);
			expect(fragment.x + fragment.width).toBeLessThanOrEqual(SHARE_CARD_WIDTH - 40);
		}
		expect(new Set(layout.fragments.map((f) => f.line)).size).toBeGreaterThan(10);
	});
});

describe('the tallest card', () => {
	it('stays under the smallest canvas limit (Safari) when exported at twice its size', () => {
		// Lines just too long for one row each wrap to two: the most rows the
		// body limits allow, short of a pathological font.
		const line = Array.from({ length: 12 }, () => 'abcde').join(' ');
		const body = Array.from({ length: 400 }, () => line).join('\n');
		const { layout } = paint(new Set(), {}, { ...message, body });
		expect(new Set(layout.fragments.map((f) => f.line)).size).toBeGreaterThan(150);
		expect(layout.width * 2 * layout.height * 2).toBeLessThan(16_777_216);
	});
});

describe('shareCardTokenAt', () => {
	it('finds the word under a point and nothing in the margin', () => {
		const { card, layout } = paint(new Set());
		const fragment = layout.fragments.find((f) => f.text === SECRET);
		if (!fragment) throw new Error('fragment missing');
		const hit = shareCardTokenAt(layout, fragment.x + 4, fragment.y + fragment.lineHeight / 2);
		expect(hit === null ? null : card.tokens[hit]?.text).toBe(SECRET);
		expect(shareCardTokenAt(layout, 5, fragment.y + 2)).toBeNull();
	});
});
