import { escapeCss } from '../sanitize';

/**
 * Build the `background-image` + position/size + `background-repeat:no-repeat`
 * CSS shorthand emitted by blocks that paint a background image (hero,
 * container, columns). `url` must already be escaped via `escapeCssUrl`.
 * That escaping is CSS-level only (a backslash before quotes), which HTML
 * ignores, so the result is HTML-escaped as well before it lands inside the
 * double-quoted `style` attribute. HTML decodes `\&quot;` back to `\"`, so
 * CSS still sees an escaped quote and ordinary URLs render unchanged.
 *
 * `order` controls whether `background-position` or `background-size` is
 * declared first. The two orders are byte-distinct strings, so the parameter
 * exists purely to preserve each call site's historical output: hero/container
 * emit position-then-size, columns emits size-then-position.
 */
export const backgroundImageCss = (
	escapedUrl: string,
	position: string,
	size: string,
	order: 'position-size' | 'size-position' = 'position-size'
): string => {
	const positionDecl = `background-position:${escapeCss(position)};`;
	const sizeDecl = `background-size:${escapeCss(size)};`;
	const ordered =
		order === 'position-size' ? `${positionDecl}${sizeDecl}` : `${sizeDecl}${positionDecl}`;
	return `background-image:url('${escapeCss(escapedUrl)}');${ordered}background-repeat:no-repeat;`;
};
