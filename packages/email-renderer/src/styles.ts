import type { RenderContext } from './types';
import { cssColorOr, sanitizeCss } from './sanitize';

export const getCssResets = (): string => {
	return `
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
table,td,th{mso-line-height-rule:exactly}
img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
table{border-collapse:collapse!important}
body{height:100%!important;margin:0!important;padding:0!important;width:100%!important}
h1,h2,h3,h4,h5,h6{margin:0;padding:0}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
#MessageViewBody a{color:inherit;text-decoration:none;font-size:inherit;font-family:inherit;font-weight:inherit;line-height:inherit}
.ExternalClass{width:100%}
.ExternalClass,.ExternalClass p,.ExternalClass span,.ExternalClass font,.ExternalClass td,.ExternalClass div{line-height:100%}
`;
};

export const getMediaQueries = (ctx: RenderContext): string => {
	const bp = ctx.breakpoint;
	const responsiveRules =
		ctx.responsiveRules.length > 0 ? '\n' + ctx.responsiveRules.join('\n') : '';
	return `
@media only screen and (max-width:${bp}px){
body{width:100%!important;min-width:100%!important}
table[class="owlat-wrap"]{width:100%!important}
.owlat-col{display:block!important;width:100%!important;max-width:100%!important}
.owlat-col-table{width:100%!important}
.owlat-wrap{max-width:100%!important}
.owlat-fluid-img{width:100%!important;height:auto!important}
.owlat-hide-mobile{display:none!important;max-height:0!important;overflow:hidden!important;mso-hide:all!important}
.owlat-full-width-inner{width:100%!important;max-width:100%!important}
.owlat-show-mobile{display:block!important;max-height:none!important}${responsiveRules}
}
@media only screen and (min-width:${bp + 1}px){
.owlat-hide-desktop{display:none!important;max-height:0!important;overflow:hidden!important;mso-hide:all!important}
}
`;
};

export const getVariableStyles = (ctx: RenderContext): string => {
	return `
.${ctx.variableClass}{
background:linear-gradient(135deg,rgba(212,255,0,0.15),rgba(212,255,0,0.08));
border:1px solid rgba(212,255,0,0.4);
border-radius:4px;
padding:1px 6px;
font-family:monospace;
color:#9acd32;
}
`;
};

/**
 * Theme colours written into the `<style>` element. Each one must be a plain
 * colour value; anything else gets the default.
 */
const darkModeColors = (ctx: RenderContext): { bg: string; text: string; link: string } => ({
	bg: cssColorOr(ctx.theme.darkModeBackgroundColor, '#121212'),
	text: cssColorOr(ctx.theme.darkModeTextColor, '#e4e4e7'),
	link: cssColorOr(ctx.theme.darkModeLinkColor, '#93c5fd'),
});

export const getDarkModeStyles = (ctx: RenderContext): string => {
	if (!ctx.darkMode) return '';
	const { bg, text, link } = darkModeColors(ctx);
	// The preview shows what a client following `prefers-color-scheme: dark`
	// shows, and runs in a browser that parses `:where()`.
	return `
body{background-color:${bg}!important}
.body-section{background-color:${bg}!important}
.owlat-dark-bg{background-color:var(--dark-bg)!important}
${darkTextRules({ text, link }, (exclusions) => `:where(${exclusions})`)}
${ownTextRules(ctx)}
.${ctx.variableClass}{
background:linear-gradient(135deg,rgba(212,255,0,0.25),rgba(212,255,0,0.15))!important;
border-color:rgba(212,255,0,0.6)!important;
color:#d4ff00!important;
}
`;
};

/** The media query the email's own dark-mode rules sit behind. */
const PREFERS_DARK_QUERY = '(prefers-color-scheme:dark)';

/**
 * The rendered email as a client set to one colour scheme shows it: the
 * email's own `prefers-color-scheme: dark` rules (colours, the dark logo swap)
 * always apply for `dark` and never for `light`, whatever the viewer's system
 * says. The brand kit preview pins the scheme this way. Clients that recolour
 * an email by themselves (the Gmail app, Outlook) are not modelled.
 */
export const forceColorScheme = (html: string, scheme: 'light' | 'dark'): string =>
	html.replaceAll(PREFERS_DARK_QUERY, scheme === 'dark' ? 'all' : 'not all');

/** Elements whose text colour the dark styles take over. */
const DARK_TEXT_TAGS = ['p', 'span', 'div', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/**
 * An inline span that paints a background, such as a highlight. Pasted text
 * often carries `background-color:transparent`, which paints nothing.
 */
const HIGHLIGHT = 'span[style*="background"]:not([style*="transparent"])';

/**
 * The colour of text without a colour of its own on a surface that keeps its
 * light-mode background, instead of the forced colour it would inherit.
 */
const ownTextColor = (ctx: RenderContext): string => cssColorOr(ctx.theme.bodyTextColor, '#333333');

/**
 * Text without a colour of its own, on a surface or a highlight that keeps its
 * light-mode background, gets the body text colour instead of inheriting the
 * forced one. A highlight on such a surface is left out: it inherits the
 * colour of the text around it, which that surface keeps.
 */
const ownTextRules = (ctx: RenderContext): string => {
	const color = ownTextColor(ctx);
	return `.owlat-own-bg{color:${color}}
${HIGHLIGHT}:not(.owlat-own-bg *){color:${color}}`;
};

/**
 * A surface that paints its own background keeps it in dark mode, so its text
 * keeps its light-mode colour: whatever is, or sits inside, an
 * `OWN_BACKGROUND_CLASS` surface (`helpers/table.ts`) or a highlight is left
 * out of the forced colours.
 */
const OWN_COLOR_EXCLUSIONS = `:not(.owlat-own-bg):not(.owlat-own-bg *):not(${HIGHLIGHT}):not(${HIGHLIGHT} *)`;

/**
 * The forced text colour, a block's own `darkTextColor`, and the link colour.
 * `.owlat-dark-text <tag>` outranks the forced `<tag>` rule by its class, so
 * the block's colour reaches the elements that carry the inline text colour.
 * Button anchors (`.owlat-button`) keep their label colour on their own fill.
 * `wrap` decides how the exclusions are written; see `getDarkModeMediaQuery`.
 */
const darkTextRules = (
	colors: { text: string; link: string },
	wrap: (exclusions: string) => string
): string => {
	const own = wrap(OWN_COLOR_EXCLUSIONS);
	const forcedText = DARK_TEXT_TAGS.map((tag) => `${tag}${own}`).join(',');
	const blockText = [
		'.owlat-dark-text',
		...DARK_TEXT_TAGS.map((tag) => `.owlat-dark-text ${tag}${own}`),
	].join(',');
	const link = `a${wrap(`:not(.owlat-button)${OWN_COLOR_EXCLUSIONS}`)}`;
	return `${forcedText}{color:${colors.text}!important}
${blockText}{color:var(--dark-text)!important}
${link}{color:${colors.link}!important}`;
};

/**
 * Real dark mode support via prefers-color-scheme media query.
 * Applied in actual email clients (not the preview toggle).
 *
 * The exclusions sit in `:where()`, so the forced rules keep the specificity
 * of a bare tag and an author's `customCss` dark rules still win over them.
 * Mail on iOS 13 and macOS 10.15 follows the dark media query but cannot
 * parse `:where()` and would drop those rules, so it gets the same rules with
 * bare `:not()` exclusions. Wrapped in parentheses, `selector()` is an unknown
 * condition such an engine reads as false; an engine that knows `selector()`
 * and `:where()` skips the block, so the fallback's higher specificity never
 * meets an author's rules there.
 *
 * Outlook.com (`[data-ogsc]`) recolours light backgrounds itself, so its
 * forced text colour keeps no exclusions for surfaces with their own
 * background; its rules use only CSS 3 selectors.
 */
export const getDarkModeMediaQuery = (ctx: RenderContext): string => {
	const { bg, text, link } = darkModeColors(ctx);
	const ogscBlockText = [
		'[data-ogsc] .owlat-dark-text',
		...DARK_TEXT_TAGS.map((tag) => `[data-ogsc] .owlat-dark-text ${tag}`),
	].join(',');
	return `
.owlat-light-img{display:block}
.owlat-dark-img{display:none}
@media ${PREFERS_DARK_QUERY}{
body,.body-bg{background-color:${bg}!important}
.owlat-wrap{background-color:${bg}!important}
.owlat-dark-bg{background-color:var(--dark-bg)!important}
${darkTextRules({ text, link }, (exclusions) => `:where(${exclusions})`)}
${ownTextRules(ctx)}
@supports not (selector(:where(a))){
${darkTextRules({ text, link }, (exclusions) => exclusions)}
}
img{opacity:0.9}
.owlat-light-img{display:none!important}
.owlat-dark-img{display:block!important}
}
[data-ogsc] body,[data-ogsc] .body-bg{background-color:${bg}!important}
[data-ogsc] .owlat-dark-bg{background-color:var(--dark-bg)!important}
[data-ogsc] p,[data-ogsc] span,[data-ogsc] div,[data-ogsc] td{color:${text}!important}
${ogscBlockText}{color:var(--dark-text)!important}
[data-ogsc] a:not(.owlat-button){color:${link}!important}
[data-ogsc] .owlat-light-img{display:none!important}
[data-ogsc] .owlat-dark-img{display:block!important}
[data-ogsb] body,[data-ogsb] .body-bg{background-color:${bg}!important}
`;
};

export const getLinkStyles = (ctx: RenderContext): string => {
	const linkColor = ctx.darkMode
		? darkModeColors(ctx).link
		: cssColorOr(ctx.theme.linkColor, '#2563eb');
	return `a{color:${linkColor}}`;
};

/**
 * CSS animations (progressive enhancement).
 * Wrapped in prefers-reduced-motion check — only animates when user allows.
 * Works in Apple Mail, iOS Mail; silently degrades elsewhere.
 */
export const getAnimationStyles = (): string => {
	return `
@media (prefers-reduced-motion:no-preference){
@keyframes owlat-fade-in{from{opacity:0}to{opacity:1}}
@keyframes owlat-slide-up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.owlat-animate-fade-in{animation:owlat-fade-in 0.6s ease-out both}
.owlat-animate-slide-up{animation:owlat-slide-up 0.6s ease-out both}
}
`;
};

export const buildStyleBlock = (ctx: RenderContext): string => {
	const globalRules = ctx.globalRules.length > 0 ? '\n' + ctx.globalRules.join('\n') : '';
	const parts = [
		getCssResets(),
		getLinkStyles(ctx),
		getVariableStyles(ctx),
		getDarkModeStyles(ctx),
		getDarkModeMediaQuery(ctx),
		getAnimationStyles(),
		globalRules,
		getMediaQueries(ctx),
	];
	if (ctx.customCss) {
		parts.push(sanitizeCss(ctx.customCss));
	}
	return `<style>${parts.join('\n')}</style>`;
};
