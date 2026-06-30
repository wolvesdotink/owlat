export const buildInlineStyle = (styles: Record<string, string | number | undefined>): string => {
	return Object.entries(styles)
		.filter(([, value]) => value !== undefined && value !== '')
		.map(([key, value]) => `${key}:${value}`)
		.join(';');
};

export const buildInlineStyleFromPairs = (pairs: [string, string | undefined][]): string => {
	return pairs
		.filter(([, value]) => value !== undefined && value !== '')
		.map(([key, value]) => `${key}:${value}`)
		.join(';');
};

/**
 * Build the `background-image` + position/size + `background-repeat:no-repeat`
 * CSS shorthand emitted by blocks that paint a background image (hero,
 * container, columns). `url` must already be escaped via `escapeCssUrl`.
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
	order: 'position-size' | 'size-position' = 'position-size',
): string => {
	const positionDecl = `background-position:${position};`;
	const sizeDecl = `background-size:${size};`;
	const ordered = order === 'position-size' ? `${positionDecl}${sizeDecl}` : `${sizeDecl}${positionDecl}`;
	return `background-image:url('${escapedUrl}');${ordered}background-repeat:no-repeat;`;
};
