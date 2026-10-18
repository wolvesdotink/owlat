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

import {
	composite,
	contrastRatio,
	parseCssColor,
	systemColorHex,
	toCss,
	WHITE,
	type Rgba,
} from './postboxCssColor';
import {
	appendWinning,
	backgroundColorOf,
	encodeAttr,
	findStyleAttr,
	hasBackgroundImage,
	isBackgroundProp,
	isNonTransparentBackground,
	paintsBackground,
	serialize,
	splitImportant,
	styleDeclarations,
	winningDecl,
	type Decl,
} from './postboxInlineStyle';

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

/* ------------------------------------------------------------------ */
/* Classification: simple vs designed                                 */
/* ------------------------------------------------------------------ */

/** Tags that count as "large containers" for background detection. */
const CONTAINER_TAGS = new Set(['body', 'table', 'tr', 'td', 'th', 'div', 'center', 'section']);

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
export const LIGHT_TEXT = '#1a1a1a';

/**
 * A background closer to white than this is the light page itself, not a
 * surface the sender meant to show. #ebebeb sits at roughly 1.2:1 against white.
 */
const CANVAS_MAX_CONTRAST = 1.2;

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

/**
 * What an element's content reads against: the dark page (where the light page
 * was), a dark or colored fill the sender set, or a light fill the sender's
 * colors were chosen for.
 */
type Surface = 'page' | 'dark' | 'light';

interface Adapted {
	decls: Decl[];
	surface: Surface;
	/**
	 * The opaque color a dropped white fill showed behind this element's content
	 * in light mode, if one was dropped from it or an ancestor.
	 */
	canvasFill: Rgba | null;
}

/** What `<mark>`'s default style paints under its content. */
const MARK_DEFAULTS = {
	surface: 'light' as Surface,
	text: { value: '#000000', rgba: { r: 0, g: 0, b: 0, a: 1 } } as SenderText,
	canvasFill: null,
};

/**
 * Writes system color keywords out as the light scheme paints them. Content
 * kept on a light surface was written against that scheme, but the iframe
 * renders dark, where `windowtext` would turn white on the light fill.
 */
function pinSystemColors(decls: Decl[]): Decl[] {
	return decls.map((d) => {
		if (d.prop !== 'color' && !isBackgroundProp(d.prop)) return d;
		const { value, important } = splitImportant(d.value);
		const hex = systemColorHex(value);
		if (!hex) return d;
		return { prop: d.prop, value: important ? `${hex} !important` : hex };
	});
}

/** Void elements in the sanitizer allowlist: they open no element to close. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * Adapts one element's style on the dark page or a dark fill (`surface`).
 * `ownColor` is its own text color declaration, `text` the sender's color its
 * text renders with, and `under` the color of the white fill dropped from an
 * ancestor.
 */
function adaptOnDark(
	decls: Decl[],
	ownColor: Decl | undefined,
	text: SenderText,
	surface: 'page' | 'dark',
	under: Rgba | null
): Adapted {
	// Under a dropped white fill, the element was drawn on that fill. A
	// translucent (or transparent) fill of its own is resolved to the opaque
	// color it showed there, and judged like any fill below; text the sender hid
	// on the dropped fill (white on white) gets it back, so it stays hidden.
	// Fills that cannot be read (images, gradients) are left alone.
	if (under && !hasBackgroundImage(decls)) {
		const ownDecl = winningDecl(decls, isBackgroundProp);
		const own = ownDecl ? backgroundColorOf(ownDecl) : null;
		if (ownDecl && /^inherit$/i.test(splitImportant(ownDecl.value).value)) {
			// It inherited the dropped fill itself.
			decls = appendWinning(decls, 'background-color', toCss(under));
		} else if (own && own.rgba.a < 1) {
			decls = appendWinning(decls, 'background-color', toCss(composite(own.rgba, under)));
		} else if (!ownDecl && ownColor && !textShowsOn(text, under)) {
			decls = appendWinning(decls, 'background-color', toCss(under));
		}
	}

	// A white fill on a dark page is a white box, and the text inside it has just
	// been lightened. Drop it so the text sits on the dark page like the rest of
	// the body. Only on the page: inside a colored fill it was a visible chip in
	// light mode too. Kept when an image paints on top of it, or when the text
	// did not show on it (white-on-white hidden text stays hidden).
	let canvasFill = under;
	const backgroundDecl = winningDecl(decls, isBackgroundProp);
	const background = backgroundDecl ? backgroundColorOf(backgroundDecl) : null;
	if (
		surface === 'page' &&
		background &&
		background.rgba.a > 0 &&
		isCanvasBackground(background.rgba) &&
		!hasBackgroundImage(decls) &&
		textShowsOn(text, background.rgba)
	) {
		// No image is in effect here, so a `background-image` left behind was
		// overridden by the shorthand and would take effect once it is gone.
		decls = decls.filter((d) => !isBackgroundProp(d.prop) && d.prop !== 'background-image');
		canvasFill = composite(background.rgba, WHITE);
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
			return {
				decls: pinSystemColors(appendWinning(decls, 'color', value)),
				surface: 'light',
				canvasFill: null,
			};
		}
		return { decls: pinSystemColors(decls), surface: 'light', canvasFill: null };
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
		surface,
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
	if (!seen || isLightOnDark(seen)) {
		return { decls: pinSystemColors(decls), surface: 'light', canvasFill: null };
	}
	const readable =
		text?.rgba != null && contrastRatio(composite(text.rgba, seen), seen) >= MIN_READABLE_CONTRAST;
	if (!ownColor && !readable) {
		decls = appendWinning(decls, 'color', POSTBOX_DARK_PALETTE.text);
	}
	return { decls, surface: 'dark', canvasFill: null };
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
	const stack: Array<{ tag: string; surface: Surface; text: SenderText; canvasFill: Rgba | null }> =
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

			const outer = stack.at(-1) ?? { surface: 'page' as Surface, text: null, canvasFill: null };
			const isVoid = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs);
			const styleAttr = findStyleAttr(attrs);
			const decls = styleAttr ? styleDeclarations(styleAttr.value) : [];
			// `<mark>` paints yellow with black text by default. While that yellow
			// shows, its content sits on a light surface. A background of its own
			// replaces the yellow and is judged as usual, except that a white one is
			// never dropped: the yellow would show through.
			const isMark = tag === 'mark';
			const markBackground = isMark ? winningDecl(decls, isBackgroundProp) : undefined;
			// `revert` puts the default yellow back.
			const markYellow =
				isMark &&
				(!markBackground ||
					/^(revert|revert-layer)$/i.test(splitImportant(markBackground.value).value));
			const parent = markYellow ? MARK_DEFAULTS : outer;
			if (!styleAttr) {
				if (!isVoid) stack.push({ ...parent, tag });
				return full;
			}

			const { own: ownColor, text } = resolveTextColor(
				decls,
				isMark ? MARK_DEFAULTS.text : parent.text
			);
			let adapted =
				parent.surface === 'light'
					? adaptOnLight(decls, ownColor, text)
					: adaptOnDark(decls, ownColor, text, isMark ? 'dark' : parent.surface, parent.canvasFill);
			if (isMark && !markYellow && parent.surface !== 'light' && adapted.surface === 'dark') {
				adapted = {
					...adapted,
					// Its default black text does not read on the dark page or a dark fill.
					decls: ownColor
						? adapted.decls
						: appendWinning(adapted.decls, 'color', POSTBOX_DARK_PALETTE.text),
					// Without a fill, its content is back on the surrounding surface.
					surface: paintsBackground(adapted.decls) ? 'dark' : outer.surface,
				};
			}

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
