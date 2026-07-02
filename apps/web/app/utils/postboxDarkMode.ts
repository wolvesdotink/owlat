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
 * Lightens an unreadable text color for the dark background while keeping its
 * hue (dark red stays reddish, near-black becomes near-white).
 */
export function lightenForDark(color: Rgba): Rgba {
	let current = { ...color, a: 1 };
	// Blend towards white until readable (bounded loop; pure + deterministic).
	for (let i = 0; i < 12 && !isReadableOnDark(current); i++) {
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

function styleDeclarations(style: string): Array<{ prop: string; value: string }> {
	return style
		.split(';')
		.map((decl) => {
			const idx = decl.indexOf(':');
			if (idx === -1) return null;
			return {
				prop: decl.slice(0, idx).trim().toLowerCase(),
				value: decl.slice(idx + 1).trim(),
			};
		})
		.filter((d): d is { prop: string; value: string } => d !== null && d.prop.length > 0);
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

/**
 * Remaps inline `color:` declarations that would be unreadable on the dark
 * background. Elements that set their OWN non-transparent background (e.g. a
 * white-on-blue button) are left completely untouched — their colors were
 * designed as a pair. Readable colored text is kept as-is.
 *
 * Operates on the sanitized string only; never touches tags without a style
 * attribute, so it cannot change document structure.
 */
export function remapInlineColorsForDark(sanitizedHtml: string): string {
	return sanitizedHtml.replace(
		/style\s*=\s*(["'])(.*?)\1/gi,
		(full, quote: string, style: string) => {
			const decls = styleDeclarations(style);
			const hasOwnBackground = decls.some(
				(d) =>
					(d.prop === 'background' || d.prop === 'background-color') &&
					isNonTransparentBackground(d.value)
			);
			if (hasOwnBackground) return full;

			let changed = false;
			const remapped = decls.map((d) => {
				if (d.prop !== 'color') return d;
				const parsed = parseCssColor(d.value);
				if (!parsed || parsed.a === 0) return d;
				if (isReadableOnDark(parsed)) return d;
				changed = true;
				return { prop: 'color', value: toCss(lightenForDark(parsed)) };
			});
			if (!changed) return full;
			const rebuilt = remapped.map((d) => `${d.prop}:${d.value}`).join(';');
			return `style=${quote}${rebuilt}${quote}`;
		}
	);
}

/* ------------------------------------------------------------------ */
/* Base stylesheet per scheme                                         */
/* ------------------------------------------------------------------ */

/**
 * Base <style> for the iframe head. The light output is byte-identical to
 * the historical BASE_STYLE so the light path is a zero-change no-op.
 */
export function buildBaseStyle(scheme: PostboxRenderScheme): string {
	if (scheme === 'dark') {
		return (
			'<style>:root{color-scheme:dark;}' +
			`html,body{font-family:-apple-system,Segoe UI,sans-serif;color:${POSTBOX_DARK_PALETTE.text};background:${POSTBOX_DARK_PALETTE.background};font-size:14px;line-height:1.55;margin:0;padding:0;}` +
			'img{max-width:100%;height:auto;}' +
			`a{color:${POSTBOX_DARK_PALETTE.link};}` +
			`blockquote{border-color:${POSTBOX_DARK_PALETTE.mutedBorder};}` +
			'</style>'
		);
	}
	return `<style>html,body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.55;margin:0;padding:0;}img{max-width:100%;height:auto;}a{color:#0a6cdd;}</style>`;
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
 */
export function adaptEmailHtml(
	sanitizedHtml: string,
	appScheme: PostboxRenderScheme
): { html: string; scheme: PostboxRenderScheme; kind: EmailHtmlKind } {
	if (appScheme === 'light') {
		return { html: sanitizedHtml, scheme: 'light', kind: 'simple' };
	}
	const kind = classifyEmailHtml(sanitizedHtml);
	if (kind === 'designed') {
		return { html: sanitizedHtml, scheme: 'light', kind };
	}
	return { html: remapInlineColorsForDark(sanitizedHtml), scheme: 'dark', kind };
}
