/**
 * Read what the pre-send checks need out of the rendered HTML: its size, its
 * links, its images and its visible text. The HTML is parsed into an inert
 * document (`DOMParser` loads no images and runs no scripts).
 */

export interface ScannedLink {
	/** The `href` exactly as written, merge tags included. */
	href: string;
	/** The visible text, collapsed; '' for an image-only link. */
	text: string;
}

export interface ScannedImage {
	src: string;
	/** `null` when the attribute is missing altogether. */
	alt: string | null;
	/** A `width` attribute or a CSS `width` on the element. */
	hasWidth: boolean;
}

export interface ScannedHtml {
	/** UTF-8 bytes of the HTML as stored. */
	bytes: number;
	links: ScannedLink[];
	images: ScannedImage[];
	/** The text a reader sees, whitespace collapsed. */
	text: string;
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

export function scanHtml(html: string): ScannedHtml {
	const bytes = new TextEncoder().encode(html).length;
	const doc = new DOMParser().parseFromString(html, 'text/html');
	// Hidden machinery is not content: the preheader and MSO conditionals.
	for (const node of doc.querySelectorAll('style, script, title')) node.remove();

	const links = [...doc.querySelectorAll('a')].map((anchor) => ({
		href: anchor.getAttribute('href') ?? '',
		text: collapse(anchor.textContent ?? ''),
	}));

	const images = [...doc.querySelectorAll('img')].map((img) => {
		const style = img.getAttribute('style') ?? '';
		return {
			src: img.getAttribute('src') ?? '',
			alt: img.getAttribute('alt'),
			hasWidth: img.hasAttribute('width') || /(^|;)\s*width\s*:/i.test(style),
		};
	});

	return { bytes, links, images, text: collapse(doc.body?.textContent ?? '') };
}

/** Merge-tag syntax the send path fills (`delivery/sendComposition/personalization.ts`). */
const MERGE_TAG = /\{\{(\w+)(?:\|'([^']*)')?\}\}/g;

export function hasMergeTag(value: string): boolean {
	return value.includes('{{') || value.includes('}}');
}

/** True when every `{{` … `}}` in `value` is a tag the send path can fill. */
export function mergeTagsWellFormed(value: string): boolean {
	const stripped = value.replace(MERGE_TAG, '');
	return !stripped.includes('{{') && !stripped.includes('}}');
}

/** `value` with its merge tags removed, which is how a URL is probed. */
export function withoutMergeTags(value: string): string {
	return value.replace(MERGE_TAG, '');
}
