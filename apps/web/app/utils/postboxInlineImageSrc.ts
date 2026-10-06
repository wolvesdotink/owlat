/**
 * The display `src` of the images pasted into the Postbox editor (#1285).
 *
 * An inline image is `<img data-inline-cid="X">` in the body, with its bytes on
 * the draft row as the inline part with Content-ID `X`. What the editor shows it
 * from is a session matter: the `blob:` preview of a paste only lives as long as
 * the tab, and a reopened draft loads it from an expiring URL for the row part. So the
 * editor saves the body WITHOUT that `src` and fills it in after every write.
 * The send path does not need it either: it rewrites each marked image to
 * `cid:X` (`@owlat/shared/inlineImages`).
 */

const INLINE_IMAGE = 'img[data-inline-cid]';

/**
 * The editor's HTML as the draft stores it: `innerHTML`, minus the display
 * `src` of every inline image. Clones only when there is an image to strip.
 */
export function serializeComposerBody(root: HTMLElement): string {
	if (!root.querySelector(INLINE_IMAGE)) return root.innerHTML;
	const copy = root.cloneNode(true) as HTMLElement;
	for (const img of copy.querySelectorAll(INLINE_IMAGE)) img.removeAttribute('src');
	return copy.innerHTML;
}

/**
 * The one rule for an inline image's src: the URL `resolve` gives for its
 * Content-ID, or none at all. Whatever src it had before (another draft's URL,
 * a dead `blob:` an older client saved) never survives a fill, so an image
 * shows as unresolved until its own URL is known.
 */
export function fillInlineImageSources(
	root: HTMLElement,
	resolve: (contentId: string) => string | undefined
): void {
	for (const img of root.querySelectorAll(INLINE_IMAGE)) {
		const contentId = img.getAttribute('data-inline-cid');
		const url = contentId ? resolve(contentId) : undefined;
		if (!url) img.removeAttribute('src');
		else if (img.getAttribute('src') !== url) img.setAttribute('src', url);
	}
}
