import type { RenderContext } from './types';
import { sanitizeCss } from './sanitize';

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
	const responsiveRules = ctx.responsiveRules.length > 0
		? '\n' + ctx.responsiveRules.join('\n')
		: '';
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

export const getDarkModeStyles = (ctx: RenderContext): string => {
	if (!ctx.darkMode) return '';
	const bg = ctx.theme.darkModeBackgroundColor ?? '#121212';
	const text = ctx.theme.darkModeTextColor ?? '#e4e4e7';
	const link = ctx.theme.darkModeLinkColor ?? '#93c5fd';
	return `
body{background-color:${bg}!important}
.body-section{background-color:${bg}!important}
p,span,div,td,th,h1,h2,h3,h4,h5,h6{color:${text}!important}
a{color:${link}!important}
.${ctx.variableClass}{
background:linear-gradient(135deg,rgba(212,255,0,0.25),rgba(212,255,0,0.15))!important;
border-color:rgba(212,255,0,0.6)!important;
color:#d4ff00!important;
}
`;
};

/**
 * Real dark mode support via prefers-color-scheme media query.
 * Applied in actual email clients (not the preview toggle).
 */
export const getDarkModeMediaQuery = (ctx: RenderContext): string => {
	const bg = ctx.theme.darkModeBackgroundColor ?? '#121212';
	const text = ctx.theme.darkModeTextColor ?? '#e4e4e7';
	const link = ctx.theme.darkModeLinkColor ?? '#93c5fd';
	return `
.owlat-light-img{display:block}
.owlat-dark-img{display:none}
@media (prefers-color-scheme:dark){
body,.body-bg{background-color:${bg}!important}
.owlat-wrap{background-color:${bg}!important}
.owlat-dark-bg{background-color:var(--dark-bg)!important}
.owlat-dark-text{color:var(--dark-text)!important}
p,span,div,td,th,h1,h2,h3,h4,h5,h6{color:${text}!important}
a{color:${link}!important}
img{opacity:0.9}
.owlat-light-img{display:none!important}
.owlat-dark-img{display:block!important}
}
[data-ogsc] body,[data-ogsc] .body-bg{background-color:${bg}!important}
[data-ogsc] .owlat-dark-bg{background-color:var(--dark-bg)!important}
[data-ogsc] .owlat-dark-text{color:var(--dark-text)!important}
[data-ogsc] p,[data-ogsc] span,[data-ogsc] div,[data-ogsc] td{color:${text}!important}
[data-ogsc] a{color:${link}!important}
[data-ogsc] .owlat-light-img{display:none!important}
[data-ogsc] .owlat-dark-img{display:block!important}
[data-ogsb] body,[data-ogsb] .body-bg{background-color:${bg}!important}
`;
};

export const getLinkStyles = (ctx: RenderContext): string => {
	const linkColor = ctx.darkMode ? (ctx.theme.darkModeLinkColor ?? '#93c5fd') : (ctx.theme.linkColor || '#2563eb');
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
	const globalRules = ctx.globalRules.length > 0
		? '\n' + ctx.globalRules.join('\n')
		: '';
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
