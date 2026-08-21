/**
 * Accessible names for canvas blocks.
 *
 * The canvas is exposed as a `role="listbox"` of `role="option"` blocks, so
 * every block needs a name a screen reader can read out on arrow navigation.
 * A bare type name ("Text", "Text", "Text") is useless for orientation, so the
 * name is `"<type label>: <content excerpt>"` — the same excerpt a sighted user
 * sees on the canvas.
 */

import type {
	AccordionBlockContent,
	ButtonBlockContent,
	CarouselBlockContent,
	ColumnsBlockContent,
	ContainerBlockContent,
	EditorBlock,
	HeroBlockContent,
	ImageBlockContent,
	ListBlockContent,
	MenuBlockContent,
	ProgressBarBlockContent,
	RawHtmlBlockContent,
	SocialBlockContent,
	SpacerBlockContent,
	TableBlockContent,
	TextBlockContent,
	VideoBlockContent,
} from '../types';
import { getBlock } from '../registry';

/** Longest excerpt a screen reader should have to sit through before the next block. */
const MAX_EXCERPT = 60;

function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Collapse HTML to its readable text, without needing a DOM. */
function htmlToText(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

/** Last meaningful path segment of a URL, so "…/hero-banner.png" reads as "hero-banner.png". */
function fileNameFromUrl(url: string): string {
	const withoutQuery = url.split(/[?#]/)[0] ?? '';
	const segment = withoutQuery.split('/').filter(Boolean).pop();
	return segment ?? '';
}

function truncate(text: string): string {
	if (text.length <= MAX_EXCERPT) return text;
	return `${text.slice(0, MAX_EXCERPT - 1).trimEnd()}…`;
}

function joinItems(items: string[]): string {
	return items
		.map((item) => htmlToText(item))
		.filter(Boolean)
		.join(', ');
}

/**
 * A short, human excerpt of what a block currently holds. Text-bearing blocks
 * excerpt their text; structural blocks describe their shape ("3 columns") so
 * the name still says something more than the type.
 */
export function blockContentExcerpt(block: EditorBlock): string {
	const content = block.content as unknown;

	switch (block.type) {
		case 'text':
			return htmlToText((content as TextBlockContent).html ?? '');
		case 'rawHtml':
			return htmlToText((content as RawHtmlBlockContent).html ?? '');
		case 'button':
			return htmlToText((content as ButtonBlockContent).text ?? '');
		case 'image': {
			const image = content as ImageBlockContent;
			if (image.alt?.trim()) return image.alt.trim();
			if (image.decorative) return 'decorative';
			return fileNameFromUrl(image.src ?? '');
		}
		case 'video': {
			const video = content as VideoBlockContent;
			return video.alt?.trim() || fileNameFromUrl(video.videoUrl ?? '');
		}
		case 'hero': {
			const hero = content as HeroBlockContent;
			return fileNameFromUrl(hero.backgroundImage ?? '');
		}
		case 'list':
			return joinItems((content as ListBlockContent).items ?? []);
		case 'menu':
			return joinItems(((content as MenuBlockContent).items ?? []).map((i) => i.label));
		case 'accordion':
			return joinItems(((content as AccordionBlockContent).sections ?? []).map((s) => s.title));
		case 'table':
			return joinItems((content as TableBlockContent).headers ?? []);
		case 'social': {
			const links = (content as SocialBlockContent).links ?? [];
			return links
				.filter((link) => link.enabled !== false)
				.map((link) => link.platform)
				.join(', ');
		}
		case 'carousel':
			return plural(((content as CarouselBlockContent).images ?? []).length, 'image');
		case 'columns':
			return plural((content as ColumnsBlockContent).columnCount ?? 0, 'column');
		case 'container':
			return plural(((content as ContainerBlockContent).items ?? []).length, 'item');
		case 'progressBar':
			return `${(content as ProgressBarBlockContent).value ?? 0}%`;
		case 'spacer':
			return `${(content as SpacerBlockContent).height ?? 0} pixels`;
		default:
			return '';
	}
}

/**
 * Types whose whole point is content the author supplies. When one of these
 * comes back with an empty excerpt the block is genuinely unfilled, which is
 * exactly what a screen-reader user needs told. Types outside this set (divider
 * and any third-party block without an excerpt rule) carry no content, so their
 * name stays the bare type label rather than claiming to be "empty".
 */
const CONTENT_BEARING_TYPES: ReadonlySet<string> = new Set([
	'text',
	'rawHtml',
	'button',
	'image',
	'video',
	'hero',
	'list',
	'menu',
	'accordion',
	'table',
	'social',
]);

/**
 * Accessible name for a canvas block: `"<type label>: <content excerpt>"`.
 */
export function blockAccessibleLabel(block: EditorBlock): string {
	const typeLabel = getBlock(block.type)?.label ?? block.type;
	const excerpt = truncate(blockContentExcerpt(block));
	if (excerpt) return `${typeLabel}: ${excerpt}`;
	return CONTENT_BEARING_TYPES.has(block.type) ? `${typeLabel}: empty` : typeLabel;
}
