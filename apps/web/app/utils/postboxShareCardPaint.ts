/**
 * Lays out and paints the "Share as image…" card on a 2D canvas.
 *
 * The privacy rule this module carries: a redacted token's text is never drawn.
 * Its place is filled with an opaque bar or a content-free smudge, painted
 * instead of the glyphs, not over them, so the exported PNG holds no pixel of
 * the original word and no amount of image processing brings it back. Every
 * paint starts from an opaque background over the whole canvas, so a word that
 * was visible in an earlier paint is gone once it is redacted.
 *
 * Layout and paint only see the two narrow interfaces below, which a test can
 * record.
 */
import type { ShareCard, ShareCardField } from './postboxShareCard';

/** Width of one string in one CSS font. */
export type ShareCardMeasure = (text: string, font: string) => number;

/** The part of `CanvasRenderingContext2D` the paint uses. */
export interface ShareCardCanvas {
	fillStyle: string | CanvasGradient | CanvasPattern;
	font: string;
	textBaseline: CanvasTextBaseline;
	filter?: string;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	fillText(text: string, x: number, y: number): void;
}

export type ShareCardScheme = 'light' | 'dark';
export type ShareCardRedactionStyle = 'bar' | 'blur';

interface ShareCardTheme {
	background: string;
	text: string;
	muted: string;
	divider: string;
	bar: string;
	smudge: string;
}

/** Opaque colours only: nothing painted for a redaction lets anything show through. */
export const SHARE_CARD_THEMES: Record<ShareCardScheme, ShareCardTheme> = {
	light: {
		background: '#ffffff',
		text: '#1f1d1a',
		muted: '#6b6760',
		divider: '#e7e4df',
		bar: '#111111',
		smudge: '#cfcbc4',
	},
	dark: {
		background: '#1c1b19',
		text: '#f1efea',
		muted: '#a19c93',
		divider: '#34322e',
		bar: '#000000',
		smudge: '#55524c',
	},
};

export const SHARE_CARD_WIDTH = 640;
const PADDING = 40;
const CONTENT_WIDTH = SHARE_CARD_WIDTH - 2 * PADDING;

interface FieldStyle {
	weight: number;
	size: number;
	lineHeight: number;
	color: 'text' | 'muted';
	/** Space above the block. */
	gap: number;
}

const FIELD_STYLES: Record<ShareCardField, FieldStyle> = {
	sender: { weight: 600, size: 16, lineHeight: 22, color: 'text', gap: 0 },
	address: { weight: 400, size: 14, lineHeight: 20, color: 'muted', gap: 2 },
	date: { weight: 400, size: 13, lineHeight: 18, color: 'muted', gap: 2 },
	subject: { weight: 600, size: 20, lineHeight: 28, color: 'text', gap: 18 },
	body: { weight: 400, size: 15, lineHeight: 24, color: 'text', gap: 0 },
};
const DIVIDER_GAP = 18;
const PARAGRAPH_GAP = 10;

export interface ShareCardFragment {
	tokenId: number;
	text: string;
	font: string;
	color: 'text' | 'muted';
	/** Left edge and top of the line box, in CSS pixels. */
	x: number;
	y: number;
	width: number;
	lineHeight: number;
	size: number;
	/** Fragments on one line share it; adjacent redactions join across the space. */
	line: number;
}

export interface ShareCardLayout {
	width: number;
	height: number;
	fragments: ShareCardFragment[];
	dividerY: number;
}

/**
 * Word-wraps the card to {@link SHARE_CARD_WIDTH}. A word wider than a line
 * (a long URL) is broken into pieces that keep its token id, so redacting it
 * covers every piece.
 */
export function layoutShareCard(
	card: ShareCard,
	measure: ShareCardMeasure,
	fontFamily: string
): ShareCardLayout {
	const fragments: ShareCardFragment[] = [];
	let y = PADDING;
	let line = 0;
	let dividerY = 0;

	for (const block of card.blocks) {
		const style = FIELD_STYLES[block.field];
		const font = `${style.weight} ${style.size}px ${fontFamily}`;
		const space = measure(' ', font);
		if (block.field === 'body') {
			y += DIVIDER_GAP;
			dividerY = y;
			y += DIVIDER_GAP;
		}
		y += style.gap;

		for (const tokens of block.lines) {
			if (tokens.length === 0) {
				y += PARAGRAPH_GAP;
				continue;
			}
			let x = 0;
			const place = (tokenId: number, text: string, width: number) => {
				fragments.push({
					tokenId,
					text,
					font,
					color: style.color,
					x: PADDING + x,
					y,
					width,
					lineHeight: style.lineHeight,
					size: style.size,
					line,
				});
				x += width;
			};
			const newLine = () => {
				y += style.lineHeight;
				line += 1;
				x = 0;
			};
			for (const token of tokens) {
				const width = measure(token.text, font);
				const lead = x > 0 ? space : 0;
				if (x > 0 && x + lead + width > CONTENT_WIDTH) newLine();
				else x += lead;
				if (width <= CONTENT_WIDTH) {
					place(token.id, token.text, width);
					continue;
				}
				// Wider than a line, so it already starts one (the check above).
				for (const [n, piece] of breakWord(token.text, font, measure).entries()) {
					if (n > 0) newLine();
					place(token.id, piece.text, piece.width);
				}
			}
			newLine();
		}
	}

	return { width: SHARE_CARD_WIDTH, height: Math.ceil(y + PADDING), fragments, dividerY };
}

/** Splits a word into the longest pieces that fit on a line. */
function breakWord(
	text: string,
	font: string,
	measure: ShareCardMeasure
): Array<{ text: string; width: number }> {
	const pieces: Array<{ text: string; width: number }> = [];
	let piece = '';
	for (const char of Array.from(text)) {
		const next = piece + char;
		if (piece && measure(next, font) > CONTENT_WIDTH) {
			pieces.push({ text: piece, width: measure(piece, font) });
			piece = char;
		} else {
			piece = next;
		}
	}
	if (piece) pieces.push({ text: piece, width: measure(piece, font) });
	return pieces;
}

/** The box a redaction fills: the glyph height of the line, not the whole line box. */
export function redactionBox(fragment: ShareCardFragment): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const height = Math.round(fragment.size * 1.3);
	return {
		x: fragment.x,
		y: fragment.y + (fragment.lineHeight - height) / 2,
		width: fragment.width,
		height,
	};
}

export interface ShareCardPaintOptions {
	redacted: ReadonlySet<number>;
	style: ShareCardRedactionStyle;
	scheme: ShareCardScheme;
	/** Device pixels per CSS pixel of the output. */
	scale: number;
}

export function paintShareCard(
	ctx: ShareCardCanvas,
	layout: ShareCardLayout,
	options: ShareCardPaintOptions
): void {
	const theme = SHARE_CARD_THEMES[options.scheme];
	ctx.setTransform(options.scale, 0, 0, options.scale, 0, 0);
	ctx.fillStyle = theme.background;
	ctx.fillRect(0, 0, layout.width, layout.height);
	ctx.fillStyle = theme.divider;
	ctx.fillRect(PADDING, layout.dividerY, CONTENT_WIDTH, 1);
	ctx.textBaseline = 'middle';

	const { fragments } = layout;
	for (const [i, fragment] of fragments.entries()) {
		if (!options.redacted.has(fragment.tokenId)) {
			ctx.font = fragment.font;
			ctx.fillStyle = theme[fragment.color];
			ctx.fillText(fragment.text, fragment.x, fragment.y + fragment.lineHeight / 2);
			continue;
		}
		const box = redactionBox(fragment);
		// Two redacted words side by side read as one redaction, space included.
		const next = fragments[i + 1];
		if (next && next.line === fragment.line && options.redacted.has(next.tokenId)) {
			box.width = next.x - fragment.x;
		}
		if (options.style === 'bar') {
			ctx.fillStyle = theme.bar;
			ctx.fillRect(box.x, box.y, box.width, box.height);
			continue;
		}
		// The smudge is a plain shape softened at its edges; the word under it
		// was never drawn, so there is nothing for the blur to hide or reveal.
		ctx.fillStyle = theme.smudge;
		if ('filter' in ctx) ctx.filter = 'blur(2px)';
		ctx.fillRect(box.x + 1, box.y + 1, box.width - 2, box.height - 2);
		if ('filter' in ctx) ctx.filter = 'none';
	}
}

/** The token under a point of the card (CSS pixels), or null between words. */
export function shareCardTokenAt(layout: ShareCardLayout, x: number, y: number): number | null {
	for (const fragment of layout.fragments) {
		if (
			x >= fragment.x &&
			x <= fragment.x + fragment.width &&
			y >= fragment.y &&
			y < fragment.y + fragment.lineHeight
		) {
			return fragment.tokenId;
		}
	}
	return null;
}
