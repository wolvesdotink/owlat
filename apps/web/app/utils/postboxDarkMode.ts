/**
 * Adaptive dark-mode rendering helpers for received HTML email.
 *
 * Runs AFTER sanitization (input is the sanitize-html output string) and only
 * when the app is in dark mode — the light path never calls these, so light
 * rendering is byte-identical to before.
 *
 * Strategy (Apple-Mail-style):
 *  - "simple" mail (plain text-ish, no explicit backgrounds on large
 *    containers, no bgcolor attrs): render dark — dark background, light
 *    text, adjusted link color — remapping ONLY inline text colors that would
 *    be unreadable on the dark background (a luminance-contrast check decides;
 *    intentionally colored text that stays readable is kept as-is).
 *  - "designed" mail (marketing/newsletter layouts that set their own
 *    backgrounds): keep the email's own colors untouched and render it as a
 *    light "paper" card on the dark app background.
 */

/** Iframe color scheme for a rendered message. */
export type PostboxRenderScheme = 'light' | 'dark';

/** Classification of a sanitized HTML email body. */
export type EmailHtmlKind = 'simple' | 'designed';

/** Dark palette used inside the sandboxed iframe (simple mail only). */
export const POSTBOX_DARK_PALETTE = {
	background: '#1c1c1e',
	text: '#e8e8ea',
	link: '#6cb2ff',
	mutedBorder: '#3a3a3c',
	mutedText: '#a1a1a6',
} as const;

/* ------------------------------------------------------------------ */
/* Color parsing + luminance                                          */
/* ------------------------------------------------------------------ */

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

const NAMED_COLORS: Record<string, string> = {
	black: '#000000',
	white: '#ffffff',
	gray: '#808080',
	grey: '#808080',
	silver: '#c0c0c0',
	red: '#ff0000',
	maroon: '#800000',
	orange: '#ffa500',
	yellow: '#ffff00',
	olive: '#808000',
	green: '#008000',
	lime: '#00ff00',
	teal: '#008080',
	aqua: '#00ffff',
	cyan: '#00ffff',
	blue: '#0000ff',
	navy: '#000080',
	purple: '#800080',
	fuchsia: '#ff00ff',
	magenta: '#ff00ff',
};

const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%|deg)?$/;

function parseNumber(raw: string): { n: number; unit: string } | null {
	const m = raw.match(NUMBER);
	return m ? { n: Number(m[1]), unit: m[2] ?? '' } : null;
}

const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));

/**
 * Parses the arguments of rgb()/rgba()/hsl()/hsla(), comma- or
 * space-separated, with an optional `/ alpha`, numbers or percentages.
 */
function parseColorFunction(isHsl: boolean, args: string): Rgba | null {
	const parts = args
		.trim()
		.split(/\s*[,/]\s*|\s+/)
		.filter(Boolean)
		.map(parseNumber);
	if ((parts.length !== 3 && parts.length !== 4) || parts.some((p) => p === null)) return null;
	const [x, y, z, alphaPart] = parts as Array<{ n: number; unit: string }>;
	const a = alphaPart ? clamp(alphaPart.unit === '%' ? alphaPart.n / 100 : alphaPart.n, 1) : 1;
	if (!isHsl) {
		const channel = (p: { n: number; unit: string }) =>
			Math.round(clamp(p.unit === '%' ? p.n * 2.55 : p.n, 255));
		if ([x!, y!, z!].some((p) => p.unit === 'deg')) return null;
		return { r: channel(x!), g: channel(y!), b: channel(z!), a };
	}
	if (y!.unit !== '%' || z!.unit !== '%') return null;
	const h = (((x!.n % 360) + 360) % 360) / 360;
	const sat = clamp(y!.n, 100) / 100;
	const light = clamp(z!.n, 100) / 100;
	const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
	const p = 2 * light - q;
	const hue = (t: number) => {
		const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
		if (u < 1 / 6) return p + (q - p) * 6 * u;
		if (u < 1 / 2) return q;
		if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
		return p;
	};
	return {
		r: Math.round(hue(h + 1 / 3) * 255),
		g: Math.round(hue(h) * 255),
		b: Math.round(hue(h - 1 / 3) * 255),
		a,
	};
}

/**
 * Parses a CSS color value (hex, rgb()/rgba(), hsl()/hsla(), common named
 * colors).
 * Returns null for anything unparseable (gradients, var(), currentColor…) —
 * callers must treat null as "do not touch".
 */
export function parseCssColor(raw: string): Rgba | null {
	const value = raw.trim().toLowerCase();
	if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
	const named = NAMED_COLORS[value];
	const v = named ?? value;

	const hexMatch = v.match(/^#([0-9a-f]{3,8})$/);
	if (hexMatch?.[1]) {
		const hex = hexMatch[1];
		if (hex.length === 3 || hex.length === 4) {
			const r = parseInt(hex[0]! + hex[0]!, 16);
			const g = parseInt(hex[1]! + hex[1]!, 16);
			const b = parseInt(hex[2]! + hex[2]!, 16);
			const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
			return { r, g, b, a };
		}
		if (hex.length === 6 || hex.length === 8) {
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
			return { r, g, b, a };
		}
		return null;
	}

	const fnMatch = v.match(/^(rgba?|hsla?)\(([^()]*)\)$/);
	if (fnMatch) return parseColorFunction(fnMatch[1]!.startsWith('hsl'), fnMatch[2]!);

	return null;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: Rgba): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

const MIN_READABLE_CONTRAST = 3;

/** True when `color` text is readable on the dark iframe background. */
export function isReadableOnDark(color: Rgba): boolean {
	const bg = parseCssColor(POSTBOX_DARK_PALETTE.background)!;
	return contrastRatio(color, bg) >= MIN_READABLE_CONTRAST;
}

/**
 * Contrast a remapped color is lifted to: WCAG AA for body text. Higher than
 * the "is it readable at all" cut-off above, which only decides whether to
 * touch a color — stopping at 3:1 turned Outlook's `color:black` signatures
 * into a dim mid-gray.
 */
const REMAP_TARGET_CONTRAST = 4.5;

/** Channel spread under which a color reads as gray rather than a hue. */
const NEUTRAL_SPREAD = 24;

/**
 * Lightens an unreadable text color for the dark background. Grays (black,
 * #333…) mean "the default text color" and become the palette's text color, so
 * they match the rest of the body; a hue keeps its hue (dark red stays reddish)
 * and is blended towards white until it clears AA contrast.
 */
export function lightenForDark(color: Rgba): Rgba {
	const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
	if (spread <= NEUTRAL_SPREAD) return parseCssColor(POSTBOX_DARK_PALETTE.text)!;
	const bg = parseCssColor(POSTBOX_DARK_PALETTE.background)!;
	let current = { ...color, a: 1 };
	// Blend towards white until readable (bounded loop; pure + deterministic).
	for (let i = 0; i < 12 && contrastRatio(current, bg) < REMAP_TARGET_CONTRAST; i++) {
		current = {
			r: Math.min(255, Math.round(current.r + (255 - current.r) * 0.25)),
			g: Math.min(255, Math.round(current.g + (255 - current.g) * 0.25)),
			b: Math.min(255, Math.round(current.b + (255 - current.b) * 0.25)),
			a: 1,
		};
	}
	return current;
}

function toCss({ r, g, b }: Rgba): string {
	const hex = (n: number) => n.toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/* ------------------------------------------------------------------ */
/* Classification: simple vs designed                                 */
/* ------------------------------------------------------------------ */

/** Tags that count as "large containers" for background detection. */
const CONTAINER_TAGS = new Set(['body', 'table', 'tr', 'td', 'th', 'div', 'center', 'section']);

function isNonTransparentBackground(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (/^(transparent|none|inherit|initial|unset)$/i.test(trimmed)) return false;
	const parsed = parseCssColor(trimmed);
	if (parsed) return parsed.a > 0;
	// Unparseable (gradient, url(), var()) — assume it paints something.
	return true;
}

type Decl = { prop: string; value: string };

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
function encodeAttr(css: string, quote: '"' | "'"): string {
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
function styleDeclarations(style: string): Decl[] {
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

interface StyleAttr {
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
function findStyleAttr(attrs: string): StyleAttr | null {
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

/**
 * Classifies sanitized email HTML.
 *
 * "designed" when the mail paints its own canvas: any bgcolor attribute, or
 * an explicit non-transparent background/background-color/background-image on
 * a large container element. Everything else (mostly-text mail) is "simple"
 * and safe to render dark.
 */
export function classifyEmailHtml(sanitizedHtml: string): EmailHtmlKind {
	// bgcolor attrs only survive sanitization on table elements — always a
	// tell for table-layout "designed" mail.
	if (/\sbgcolor\s*=/i.test(sanitizedHtml)) return 'designed';

	const tagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = tagRe.exec(sanitizedHtml)) !== null) {
		const tag = match[1]!.toLowerCase();
		if (!CONTAINER_TAGS.has(tag)) continue;
		const attrs = match[2] ?? '';
		const style = findStyleAttr(attrs)?.value;
		if (!style) continue;
		for (const { prop, value } of styleDeclarations(style)) {
			if (prop === 'background-image') return 'designed';
			if (prop === 'background' || prop === 'background-color') {
				if (isNonTransparentBackground(value)) return 'designed';
			}
		}
	}
	return 'simple';
}

/* ------------------------------------------------------------------ */
/* Inline color remap for the dark (simple) path                      */
/* ------------------------------------------------------------------ */

/** Text color of the light scheme, given to text that sits on a light surface. */
const LIGHT_TEXT = '#1a1a1a';

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * A background closer to white than this is the light page itself, not a
 * surface the sender meant to show. #ebebeb sits at roughly 1.2:1 against white.
 */
const CANVAS_MAX_CONTRAST = 1.2;

function isBackgroundProp(prop: string): boolean {
	return prop === 'background' || prop === 'background-color';
}

function splitImportant(value: string): { value: string; important: boolean } {
	const match = value.match(/^(.*?)\s*!\s*important$/i);
	return match ? { value: match[1]!, important: true } : { value, important: false };
}

/**
 * The declaration CSS applies among those whose property matches: the last
 * one, except that a normal declaration never overrides an `!important` one.
 */
function winningDecl(decls: Decl[], matches: (prop: string) => boolean): Decl | undefined {
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
function backgroundColorOf(d: Decl): { value: string; rgba: Rgba } | null {
	const { value } = splitImportant(d.value);
	const whole = parseCssColor(value);
	if (whole) return { value, rgba: whole };
	if (d.prop !== 'background') return null;
	let color: { value: string; rgba: Rgba } | null = null;
	for (const token of value.match(/[a-z-]+\([^()]*\)|[^\s()]+/gi) ?? []) {
		const rgba = parseCssColor(token);
		if (rgba) {
			if (color) return null;
			color = { value: token, rgba };
		} else if (!BACKGROUND_KEYWORD.test(token)) {
			return null;
		}
	}
	return color;
}

/**
 * Appends a declaration that has to win over the ones already there for the
 * same property, so it is `!important` when one of those is.
 */
function appendWinning(decls: Decl[], prop: string, value: string): Decl[] {
	const group = prop === 'color' ? (p: string) => p === 'color' : isBackgroundProp;
	const rival = winningDecl(decls, group);
	const important = rival !== undefined && splitImportant(rival.value).important;
	return [...decls, { prop, value: important ? `${value} !important` : value }];
}

/** `top` painted over an opaque `bottom`. */
function composite(top: Rgba, bottom: Rgba): Rgba {
	const mix = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/**
 * True for a fill that looks white or near-white gray on the light page. In
 * light mode such a fill vanishes into the page; mail editors write it all the
 * time, typically as `background-color: rgb(255, 255, 255)` on every line of
 * text pasted from a web page.
 */
function isCanvasBackground(color: Rgba): boolean {
	const seen = composite(color, WHITE);
	const spread = Math.max(seen.r, seen.g, seen.b) - Math.min(seen.r, seen.g, seen.b);
	return spread <= NEUTRAL_SPREAD && contrastRatio(seen, WHITE) < CANVAS_MAX_CONTRAST;
}

/** True when a fill, painted on the dark page, is too light for the palette's text. */
function isLightOnDark(fill: Rgba): boolean {
	const page = parseCssColor(POSTBOX_DARK_PALETTE.background)!;
	const text = parseCssColor(POSTBOX_DARK_PALETTE.text)!;
	return contrastRatio(text, composite(fill, page)) < MIN_READABLE_CONTRAST;
}

/**
 * The text color the sender's own (light) rendering used for an element:
 * null for the default dark text, `rgba: null` when it cannot be parsed.
 */
type SenderText = { value: string; rgba: Rgba | null } | null;

/**
 * Under this contrast against its background, text was hidden in light mode
 * (white on white, a near-transparent color) rather than merely faint.
 */
const HIDDEN_MAX_CONTRAST = 1.5;

/** True when text in the sender's color showed on the fill in light mode. */
function textShowsOn(text: SenderText, fill: Rgba): boolean {
	if (text === null) return true;
	if (text.rgba === null) return false;
	const seenFill = composite(fill, WHITE);
	return contrastRatio(composite(text.rgba, seenFill), seenFill) >= HIDDEN_MAX_CONTRAST;
}

/**
 * The element's own text color declaration and the sender's color its text
 * renders with. Keywords set no color of their own: `initial` resets to the
 * default, the others keep the inherited color.
 */
function resolveTextColor(
	decls: Decl[],
	inherited: SenderText
): { own: Decl | undefined; text: SenderText } {
	const decl = winningDecl(decls, (prop) => prop === 'color');
	if (!decl) return { own: undefined, text: inherited };
	const { value } = splitImportant(decl.value);
	// `color` is inherited, so `unset` and `revert` inherit as well.
	if (/^(inherit|currentcolor|unset|revert|revert-layer)$/i.test(value)) {
		return { own: undefined, text: inherited };
	}
	if (/^initial$/i.test(value)) return { own: undefined, text: null };
	return { own: decl, text: { value, rgba: parseCssColor(value) } };
}

/** True when the winning background declaration paints something. */
function paintsBackground(decls: Decl[]): boolean {
	const decl = winningDecl(decls, isBackgroundProp);
	if (!decl) return false;
	const color = backgroundColorOf(decl);
	if (color) return color.rgba.a > 0 || hasBackgroundImage([decl]);
	return isNonTransparentBackground(splitImportant(decl.value).value);
}

/** True when the style paints an image (or gradient) layer. */
function hasBackgroundImage(decls: Decl[]): boolean {
	return decls.some((d) => {
		const { value } = splitImportant(d.value);
		if (d.prop === 'background-image') return !/^none$/i.test(value);
		return d.prop === 'background' && /\b(url|[a-z-]*gradient|image-set|image)\s*\(/i.test(value);
	});
}

/**
 * What an element's content reads against: the dark page (or a dark fill), or
 * a light fill the sender's colors were chosen for.
 */
type Surface = 'dark' | 'light';

/** A white fill dropped on the dark path, which the text below it was written on. */
type Fill = { value: string; rgba: Rgba };

interface Adapted {
	decls: Decl[];
	surface: Surface;
	/** The dropped white fill this element's content sits on, if any. */
	canvasFill: Fill | null;
}

/** Void elements in the sanitizer allowlist: they open no element to close. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * Adapts one element's style on a dark surface. `ownColor` is its own text
 * color declaration, `text` the sender's color its text renders with, and
 * `under` the white fill dropped from an ancestor.
 */
function adaptOnDark(
	decls: Decl[],
	ownColor: Decl | undefined,
	text: SenderText,
	under: Fill | null
): Adapted {
	// Text the sender hid on an ancestor's white fill (white on white) would show
	// once that fill is dropped, so the element gets the fill back. A color that
	// cannot be parsed cannot be judged, so it keeps the fill too.
	if (under && ownColor && !paintsBackground(decls) && !textShowsOn(text, under.rgba)) {
		decls = appendWinning(decls, 'background-color', under.value);
	}

	// A white fill on a dark page is a white box, and the text inside it has just
	// been lightened. Drop it so the text sits on the dark page like the rest of
	// the body. Kept when an image paints on top of it, or when the text did not
	// show on it (white-on-white hidden text stays hidden).
	let canvasFill = under;
	const backgroundDecl = winningDecl(decls, isBackgroundProp);
	const background = backgroundDecl ? backgroundColorOf(backgroundDecl) : null;
	if (
		background &&
		background.rgba.a > 0 &&
		isCanvasBackground(background.rgba) &&
		!hasBackgroundImage(decls) &&
		textShowsOn(text, background.rgba)
	) {
		decls = decls.filter((d) => !isBackgroundProp(d.prop));
		canvasFill = background;
	}

	const fillDecl = winningDecl(decls, isBackgroundProp);
	if (fillDecl && paintsBackground(decls)) {
		// The element's colors were designed as a pair (a white-on-blue button)
		// and are left alone. A light fill with no text color of its own would
		// inherit the dark palette's light text, so it gets the sender's.
		const fill = backgroundColorOf(fillDecl)?.rgba ?? null;
		if (fill === null || !isLightOnDark(fill)) return { decls, surface: 'dark', canvasFill: null };
		if (!ownColor) {
			const value = text ? text.value : LIGHT_TEXT;
			return { decls: appendWinning(decls, 'color', value), surface: 'light', canvasFill: null };
		}
		return { decls, surface: 'light', canvasFill: null };
	}

	return {
		decls: decls.map((d) => {
			if (d.prop !== 'color') return d;
			const { value, important } = splitImportant(d.value);
			const parsed = parseCssColor(value);
			if (!parsed || parsed.a === 0 || isReadableOnDark(parsed)) return d;
			const lightened = toCss(lightenForDark(parsed));
			return { prop: 'color', value: important ? `${lightened} !important` : lightened };
		}),
		surface: 'dark',
		canvasFill,
	};
}

/**
 * Adapts one element's style on a light surface. The sender's colors were
 * chosen against that fill, which stays light, so they are kept. A dark fill
 * nested in it starts a dark surface again; text that inherits a color it does
 * not show on there gets the dark palette's text, as on the dark page.
 */
function adaptOnLight(decls: Decl[], ownColor: Decl | undefined, text: SenderText): Adapted {
	const fillDecl = winningDecl(decls, isBackgroundProp);
	const fill = fillDecl ? (backgroundColorOf(fillDecl)?.rgba ?? null) : null;
	const seen = fill && fill.a > 0 ? composite(fill, WHITE) : null;
	if (!seen || isLightOnDark(seen)) return { decls, surface: 'light', canvasFill: null };
	const readable =
		text?.rgba != null && contrastRatio(composite(text.rgba, seen), seen) >= MIN_READABLE_CONTRAST;
	if (!ownColor && !readable) {
		decls = appendWinning(decls, 'color', POSTBOX_DARK_PALETTE.text);
	}
	return { decls, surface: 'dark', canvasFill: null };
}

function serialize(decls: Decl[]): string {
	return decls.map((d) => `${d.prop}:${d.value}`).join(';');
}

/**
 * Remaps inline colors for the dark background.
 *
 * - Text colors that would be unreadable on the dark background are lightened;
 *   readable colored text is kept as-is.
 * - White and near-white backgrounds are dropped, because they turn into white
 *   boxes behind text that has just been lightened.
 * - Elements that set any other background keep their colors as a pair (e.g. a
 *   white-on-blue button). A light fill with no text color of its own gets the
 *   sender's text color, and nothing inside it is lightened.
 *
 * Operates on the sanitized string only and rewrites nothing but style
 * attributes, so it cannot change document structure. sanitize-html emits
 * balanced tags, which is what the element stack relies on.
 */
export function remapInlineColorsForDark(sanitizedHtml: string): string {
	// One entry per open element.
	const stack: Array<{ tag: string; surface: Surface; text: SenderText; canvasFill: Fill | null }> =
		[];
	return sanitizedHtml.replace(
		/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi,
		(full, closing: string, rawTag: string, attrs: string) => {
			const tag = rawTag.toLowerCase();
			if (closing) {
				// Balanced input closes the top element; search down only for
				// anything else.
				for (let i = stack.length - 1; i >= 0; i--) {
					if (stack[i]!.tag === tag) {
						stack.length = i;
						break;
					}
				}
				return full;
			}

			const parent = stack.at(-1) ?? {
				surface: 'dark' as Surface,
				text: null,
				canvasFill: null,
			};
			const isVoid = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs);
			const styleAttr = findStyleAttr(attrs);
			if (!styleAttr) {
				if (!isVoid) stack.push({ ...parent, tag });
				return full;
			}

			const decls = styleDeclarations(styleAttr.value);
			const { own: ownColor, text } = resolveTextColor(decls, parent.text);
			const adapted =
				parent.surface === 'light'
					? adaptOnLight(decls, ownColor, text)
					: adaptOnDark(decls, ownColor, text, parent.canvasFill);

			let rewritten = full;
			const rebuilt = serialize(adapted.decls);
			if (rebuilt !== serialize(decls)) {
				const before = attrs.slice(0, styleAttr.start);
				const after = attrs.slice(styleAttr.end);
				const { quote } = styleAttr;
				// Nothing left once the white background is gone: drop the attribute.
				const newAttrs = rebuilt
					? `${before}style=${quote}${encodeAttr(rebuilt, quote)}${quote}${after}`
					: `${before.replace(/\s+$/, '')}${after}`;
				rewritten = `<${rawTag}${newAttrs}>`;
			}
			if (!isVoid) {
				stack.push({ tag, surface: adapted.surface, text, canvasFill: adapted.canvasFill });
			}
			return rewritten;
		}
	);
}

/* ------------------------------------------------------------------ */
/* Base stylesheet per scheme                                         */
/* ------------------------------------------------------------------ */

/** The app's own UI font stack, so plain mail reads like the rest of Owlat. */
const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

/**
 * Outlook ships its paragraph reset (`p.MsoNormal{margin:0;font-size:11pt}`)
 * in a <style> block, which sanitization drops. Without it every
 * `<p>&nbsp;</p>` spacer Outlook writes between lines picks up the default 1em
 * margins on both sides, and each line box is sized from our 15px body font
 * rather than Outlook's 11pt, so a short reply balloons into a wall of blank
 * space. Restoring the reset is faithful to how the sender saw it, so it
 * applies to designed mail too. The line height stays a little looser than
 * Outlook's own for reading comfort.
 */
const OUTLOOK_RESET_STYLE =
	'p.MsoNormal,li.MsoNormal,div.MsoNormal{margin:0;font-size:11pt;line-height:1.4;}';

/**
 * Reading-typography block for "simple" (mostly-text) mail: a comfortable
 * measure capped around 72ch and aligned with the message header (not
 * centered, which left the text floating in the middle of a wide reader), a
 * slightly larger base size, a roomier line-height, long URLs that wrap instead
 * of scrolling sideways, and no stray margin above the first or below the last
 * block. The background stays transparent so the body sits directly on the
 * message card instead of in a second box. "Designed" mail (marketing /
 * newsletter layouts) never receives this — its own layout stays untouched.
 *
 * `pre` wraps: a plain-text body arrives as a `<pre style="white-space:pre-wrap">`,
 * but the sanitizer allowlist has no `white-space`, so the inline style is
 * stripped and every plain-text message ran off the card on one line.
 */
function simpleMeasureStyle(quoteBorder: string, quoteText: string): string {
	return (
		'html,body{background:transparent;}' +
		'body{max-width:72ch;font-size:15px;line-height:1.6;overflow-wrap:break-word;}' +
		'pre{white-space:pre-wrap;}' +
		'body>:first-child{margin-top:0;}body>:last-child{margin-bottom:0;}' +
		`blockquote{margin:0.5em 0 0.5em 0.25em;padding-left:0.9em;border-left:2px solid ${quoteBorder};color:${quoteText};}`
	);
}

/**
 * Base <style> for the iframe head. "Designed" mail (the default `kind`) keeps
 * its own canvas on a white paper card and only gets the shared basics; "simple"
 * mail additionally gets the reading-measure block and a transparent canvas.
 */
export function buildBaseStyle(
	scheme: PostboxRenderScheme,
	kind: EmailHtmlKind = 'designed'
): string {
	const base = `font-family:${FONT_STACK};font-size:14px;line-height:1.55;margin:0;padding:0;`;
	if (scheme === 'dark') {
		return (
			'<style>:root{color-scheme:dark;}' +
			`html,body{${base}color:${POSTBOX_DARK_PALETTE.text};background:${POSTBOX_DARK_PALETTE.background};}` +
			'img{max-width:100%;height:auto;}' +
			`a{color:${POSTBOX_DARK_PALETTE.link};}` +
			`blockquote{border-color:${POSTBOX_DARK_PALETTE.mutedBorder};}` +
			OUTLOOK_RESET_STYLE +
			(kind === 'simple'
				? simpleMeasureStyle(POSTBOX_DARK_PALETTE.mutedBorder, POSTBOX_DARK_PALETTE.mutedText)
				: '') +
			'</style>'
		);
	}
	return (
		`<style>html,body{${base}color:${LIGHT_TEXT};}` +
		'img{max-width:100%;height:auto;}a{color:#0a6cdd;}' +
		OUTLOOK_RESET_STYLE +
		(kind === 'simple' ? simpleMeasureStyle('#d4d4d8', '#52525b') : '') +
		'</style>'
	);
}

/**
 * Decides how a sanitized message body should render for the requested app
 * scheme and returns the (possibly color-remapped) HTML plus the scheme the
 * iframe should use.
 *
 * - Light app (or forced light): input returned untouched, light scheme.
 * - Dark app + simple mail: dark scheme, unreadable inline colors remapped.
 * - Dark app + designed mail: light scheme ("paper" card) with the email's
 *   own colors untouched.
 *
 * The returned `kind` is a real classification in BOTH app schemes (the light
 * path classifies too, without touching the HTML) so callers can apply
 * kind-dependent presentation such as the reading-measure base style.
 */
export function adaptEmailHtml(
	sanitizedHtml: string,
	appScheme: PostboxRenderScheme
): { html: string; scheme: PostboxRenderScheme; kind: EmailHtmlKind } {
	const kind = classifyEmailHtml(sanitizedHtml);
	if (appScheme === 'light') {
		return { html: sanitizedHtml, scheme: 'light', kind };
	}
	if (kind === 'designed') {
		return { html: sanitizedHtml, scheme: 'light', kind };
	}
	return { html: remapInlineColorsForDark(sanitizedHtml), scheme: 'dark', kind };
}
