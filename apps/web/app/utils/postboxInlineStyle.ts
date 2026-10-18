/**
 * Inline style parsing for the Postbox dark-mode adapter: reads the style
 * attribute sanitize-html writes, applies CSS precedence, reads background
 * colors, and writes declarations back.
 */

import { parseCssColor, type Rgba } from './postboxCssColor';

export function isNonTransparentBackground(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (/^(transparent|none|inherit|initial|unset)$/i.test(trimmed)) return false;
	const parsed = parseCssColor(trimmed);
	if (parsed) return parsed.a > 0;
	// Unparseable (gradient, url(), var()) — assume it paints something.
	return true;
}

export type Decl = { prop: string; value: string };

const ATTR_ENTITIES: Record<string, string> = {
	amp: '&',
	quot: '"',
	lt: '<',
	gt: '>',
	'#39': "'",
	'#x27': "'",
};

/** Decodes the entities sanitize-html writes into attribute values. */
function decodeAttr(value: string): string {
	return value.replace(/&(amp|quot|lt|gt|#39|#x27);/g, (_, name: string) => ATTR_ENTITIES[name]!);
}

/** Encodes CSS text for an attribute value delimited by `quote`. */
export function encodeAttr(css: string, quote: '"' | "'"): string {
	const encoded = css.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return quote === '"' ? encoded.replace(/"/g, '&quot;') : encoded.replace(/'/g, '&#39;');
}

/**
 * Splits CSS declarations on the semicolons that end them, not those inside a
 * quoted string or parentheses (`url(…?a=1;b=2)`).
 */
function splitDeclarations(css: string): string[] {
	const parts: string[] = [];
	let quote: string | null = null;
	let depth = 0;
	let start = 0;
	for (let i = 0; i < css.length; i++) {
		const ch = css[i]!;
		if (ch === '\\') {
			i++;
		} else if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth = Math.max(0, depth - 1);
		} else if (ch === ';' && depth === 0) {
			parts.push(css.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(css.slice(start));
	return parts;
}

/**
 * Parses a style attribute value. sanitize-html writes it entity-encoded
 * (`font-family:&quot;Arial&quot;`, `url(…?a=1&amp;b=2)`), so it is decoded
 * first: splitting the raw value on `;` cut through those entities, which
 * dropped fonts and broke image URLs.
 */
export function styleDeclarations(style: string): Decl[] {
	return splitDeclarations(decodeAttr(style))
		.map((decl) => {
			const idx = decl.indexOf(':');
			if (idx === -1) return null;
			return {
				prop: decl.slice(0, idx).trim().toLowerCase(),
				value: decl.slice(idx + 1).trim(),
			};
		})
		.filter((d): d is Decl => d !== null && d.prop.length > 0);
}

/** Attribute tokens of a tag; a quoted value is consumed whole. */
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export interface StyleAttr {
	/** Offset of the attribute name within the attribute string. */
	start: number;
	end: number;
	quote: '"' | "'";
	value: string;
}

/**
 * Finds the `style` attribute in a tag's attribute string. Walks the attributes
 * one by one, so `style=` written inside another attribute's quoted value
 * (`title=" style='…'"`) is never mistaken for it.
 */
export function findStyleAttr(attrs: string): StyleAttr | null {
	ATTR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTR_RE.exec(attrs)) !== null) {
		if (match[1]!.toLowerCase() !== 'style') continue;
		const single = match[3] !== undefined;
		return {
			start: match.index,
			end: match.index + match[0].length,
			quote: single ? "'" : '"',
			value: match[2] ?? match[3] ?? match[4] ?? '',
		};
	}
	return null;
}

export function isBackgroundProp(prop: string): boolean {
	return prop === 'background' || prop === 'background-color';
}

export function splitImportant(value: string): { value: string; important: boolean } {
	const match = value.match(/^(.*?)\s*!\s*important$/i);
	return match ? { value: match[1]!, important: true } : { value, important: false };
}

/**
 * The declaration CSS applies among those whose property matches: the last
 * one, except that a normal declaration never overrides an `!important` one.
 */
export function winningDecl(decls: Decl[], matches: (prop: string) => boolean): Decl | undefined {
	let winner: Decl | undefined;
	let winnerImportant = false;
	for (const d of decls) {
		if (!matches(d.prop)) continue;
		const { important } = splitImportant(d.value);
		if (important || !winnerImportant) {
			winner = d;
			winnerImportant = important;
		}
	}
	return winner;
}

/** Keywords and lengths a `background` shorthand may carry besides its color. */
const BACKGROUND_KEYWORD =
	/^(none|repeat|repeat-x|repeat-y|no-repeat|space|round|scroll|fixed|local|top|bottom|left|right|center|auto|cover|contain|border-box|padding-box|content-box|\/|[+-]?[\d.]+(%|px|em|rem|pt|cm|mm|in)?)$/i;

/**
 * The color a background declaration paints, with the token that spells it,
 * or null when it paints no plain color. Reads the color layer of a full
 * shorthand too (`background: rgb(255, 255, 255) none repeat scroll 0% 0%`, as
 * pasted computed styles write it) as long as it carries no image.
 */
export function backgroundColorOf(d: Decl): { value: string; rgba: Rgba } | null {
	const { value } = splitImportant(d.value);
	// Background is not inherited: the reset keywords leave it transparent.
	if (/^(initial|unset|revert|revert-layer|none)$/i.test(value)) {
		return { value: 'transparent', rgba: { r: 0, g: 0, b: 0, a: 0 } };
	}
	const whole = parseCssColor(value);
	if (whole) return { value, rgba: whole };
	if (d.prop !== 'background') return null;
	let color: { value: string; rgba: Rgba } | null = null;
	for (const token of value.match(/[a-z-]+\([^()]*\)|\/|[^\s()/]+/gi) ?? []) {
		const rgba = parseCssColor(token);
		if (rgba) {
			if (color) return null;
			color = { value: token, rgba };
		} else if (!BACKGROUND_KEYWORD.test(token)) {
			return null;
		}
	}
	// No color layer: the shorthand resets the color to transparent.
	return color ?? { value: 'transparent', rgba: { r: 0, g: 0, b: 0, a: 0 } };
}

/**
 * Appends a declaration that has to win over the ones already there for the
 * same property, so it is `!important` when one of those is.
 */
export function appendWinning(decls: Decl[], prop: string, value: string): Decl[] {
	const group = prop === 'color' ? (p: string) => p === 'color' : isBackgroundProp;
	const rival = winningDecl(decls, group);
	const important = rival !== undefined && splitImportant(rival.value).important;
	return [...decls, { prop, value: important ? `${value} !important` : value }];
}

/** True when the winning background declaration paints something. */
export function paintsBackground(decls: Decl[]): boolean {
	const decl = winningDecl(decls, isBackgroundProp);
	if (!decl) return false;
	const color = backgroundColorOf(decl);
	if (color) return color.rgba.a > 0 || hasBackgroundImage([decl]);
	return isNonTransparentBackground(splitImportant(decl.value).value);
}

/** True when the style paints an image (or gradient) layer. */
export function hasBackgroundImage(decls: Decl[]): boolean {
	// The shorthand resets the image layer, so only the winning one counts.
	const decl = winningDecl(decls, (prop) => prop === 'background' || prop === 'background-image');
	if (!decl) return false;
	const { value } = splitImportant(decl.value);
	if (decl.prop === 'background-image') return !/^none$/i.test(value);
	return /\b(url|[a-z-]*gradient|image-set|image)\s*\(/i.test(value);
}

export function serialize(decls: Decl[]): string {
	return decls.map((d) => `${d.prop}:${d.value}`).join(';');
}
