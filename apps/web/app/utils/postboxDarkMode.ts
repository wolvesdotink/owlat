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

/**
 * Parses a CSS color value (hex, rgb()/rgba(), common named colors).
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

	const rgbMatch = v.match(
		/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/
	);
	if (rgbMatch) {
		return {
			r: Math.min(255, Number(rgbMatch[1])),
			g: Math.min(255, Number(rgbMatch[2])),
			b: Math.min(255, Number(rgbMatch[3])),
			a: rgbMatch[4] === undefined ? 1 : Math.min(1, Number(rgbMatch[4])),
		};
	}

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

function styleDeclarations(style: string): Decl[] {
	// sanitize-html writes the quotes of a font name as `&quot;` inside the
	// attribute (`font-family:&quot;Arial&quot;,sans-serif`). Splitting on `;`
	// first would cut through the entity and leave `font-family:&quot`, which
	// the browser drops, so the text fell back to the default serif. CSS takes
	// single quotes equally well, and sanitize-html always double-quotes the
	// attribute, so a single quote is safe to write back.
	return style
		.replace(/&quot;/g, "'")
		.split(';')
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
		const styleMatch = attrs.match(/style\s*=\s*(["'])(.*?)\1/i);
		if (!styleMatch?.[2]) continue;
		for (const { prop, value } of styleDeclarations(styleMatch[2])) {
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

/**
 * True for a white or near-white gray background. In light mode such a fill
 * vanishes into the page; mail editors write it all the time, typically as
 * `background-color: rgb(255, 255, 255)` on every line of text pasted from a
 * web page.
 */
function isCanvasBackground(color: Rgba): boolean {
	const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
	return spread <= NEUTRAL_SPREAD && contrastRatio(color, WHITE) < CANVAS_MAX_CONTRAST;
}

/** The color a style's own background paints, or null when it is not a plain color. */
function ownBackgroundColor(decls: Decl[]): Rgba | null {
	let color: Rgba | null = null;
	for (const d of decls) {
		if (!isBackgroundProp(d.prop)) continue;
		// The last declaration wins, as in CSS. Anything that is not a plain
		// color (gradient, url(), var()) leaves the result unknown.
		color = parseCssColor(d.value);
	}
	return color;
}

/** What a possibly translucent fill looks like painted over the dark background. */
function overDarkBackground(color: Rgba): Rgba {
	const bg = parseCssColor(POSTBOX_DARK_PALETTE.background)!;
	const mix = (c: number, b: number) => Math.round(c * color.a + b * (1 - color.a));
	return { r: mix(color.r, bg.r), g: mix(color.g, bg.g), b: mix(color.b, bg.b), a: 1 };
}

/** Void elements in the sanitizer allowlist: they open no element to close. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * How one element's style is adapted for the dark (simple) path, and whether
 * its content keeps reading against a light surface.
 */
function adaptStyle(decls: Decl[]): { decls: Decl[]; lightSurface: boolean } {
	const declaredColor = [...decls].reverse().find((d) => d.prop === 'color');
	const parsedColor = declaredColor ? parseCssColor(declaredColor.value) : null;
	const background = ownBackgroundColor(decls);

	// A white fill on a dark page is a white box, and the text inside it has just
	// been lightened. Drop it so the text sits on the dark page like the rest of
	// the body. Text that only shows because of that fill (or that is hidden by
	// it) keeps its pair untouched.
	if (
		background &&
		background.a > 0 &&
		isCanvasBackground(background) &&
		(!declaredColor ||
			(parsedColor !== null && contrastRatio(parsedColor, background) >= MIN_READABLE_CONTRAST))
	) {
		decls = decls.filter((d) => !isBackgroundProp(d.prop));
	}

	const hasOwnBackground = decls.some(
		(d) => isBackgroundProp(d.prop) && isNonTransparentBackground(d.value)
	);
	if (hasOwnBackground) {
		// The element's colors were designed as a pair (a white-on-blue button)
		// and are left alone. A light fill with no text color of its own would
		// inherit the dark palette's light text, so it gets the light scheme's.
		const fill = ownBackgroundColor(decls);
		const fillIsLight =
			fill !== null &&
			fill.a > 0 &&
			contrastRatio(parseCssColor(POSTBOX_DARK_PALETTE.text)!, overDarkBackground(fill)) <
				MIN_READABLE_CONTRAST;
		if (fillIsLight && !declaredColor) {
			return { decls: [...decls, { prop: 'color', value: LIGHT_TEXT }], lightSurface: true };
		}
		return { decls, lightSurface: fillIsLight };
	}

	return {
		decls: decls.map((d) => {
			if (d.prop !== 'color') return d;
			const parsed = parseCssColor(d.value);
			if (!parsed || parsed.a === 0) return d;
			if (isReadableOnDark(parsed)) return d;
			return { prop: 'color', value: toCss(lightenForDark(parsed)) };
		}),
		lightSurface: false,
	};
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
 *   light scheme's text color, and nothing inside it is lightened.
 *
 * Operates on the sanitized string only and rewrites nothing but style
 * attributes, so it cannot change document structure. sanitize-html emits
 * balanced tags, which is what the light-surface stack relies on.
 */
export function remapInlineColorsForDark(sanitizedHtml: string): string {
	// One entry per open element: whether its content sits on a light surface.
	const stack: Array<{ tag: string; lightSurface: boolean }> = [];
	return sanitizedHtml.replace(
		/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi,
		(full, closing: string, rawTag: string, attrs: string) => {
			const tag = rawTag.toLowerCase();
			if (closing) {
				const idx = stack.map((e) => e.tag).lastIndexOf(tag);
				if (idx !== -1) stack.length = idx;
				return full;
			}

			const insideLight = stack.at(-1)?.lightSurface ?? false;
			let lightSurface = insideLight;
			// Inside a light surface the sender's colors were chosen against that
			// surface, which stays light, so they are kept as written.
			const rewritten = insideLight
				? full
				: full.replace(
						/(\s+)style\s*=\s*(["'])(.*?)\2/i,
						(attr, space: string, quote: string, style: string) => {
							const decls = styleDeclarations(style);
							const adapted = adaptStyle(decls);
							lightSurface = adapted.lightSurface;
							const rebuilt = adapted.decls.map((d) => `${d.prop}:${d.value}`).join(';');
							if (rebuilt === decls.map((d) => `${d.prop}:${d.value}`).join(';')) return attr;
							// Nothing left once the white background is gone.
							if (!rebuilt) return '';
							const escaped = quote === "'" ? rebuilt.replace(/'/g, '&quot;') : rebuilt;
							return `${space}style=${quote}${escaped}${quote}`;
						}
					);

			if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, lightSurface });
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
