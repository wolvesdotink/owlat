/**
 * Text contrast in the light rendering and in dark mode, Block by Block.
 *
 * Light: a text Block's colour against the nearest solid background (its own,
 * an enclosing container's, else the theme's), and a button's label against
 * its fill.
 *
 * Dark: the renderer's dark-mode stylesheet (`packages/email-renderer/src/
 * styles.ts`, the same rules the builder's dark preview applies) recolours all
 * text to the theme's dark-mode text colour and links to its dark-mode link
 * colour, and swaps a Block's background only when the Block sets a dark-mode
 * background. So the pairs that can fail are the theme's own (text and links
 * on the dark background) and a text Block sitting on a light fill with no
 * dark-mode background: light text on a light box.
 *
 * Only `#rgb` / `#rrggbb` colours are measured; anything else (a gradient, an
 * image, a named colour) is skipped rather than guessed.
 */
import { getContrastRatio } from '@owlat/email-renderer';
import { childBlockLists } from '@owlat/shared/blockTree';
import type { EditorBlock, EmailTheme } from '@owlat/shared';
import type { PresendItem } from './types';
import { WCAG_AA_CONTRAST } from './types';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const solid = (value: unknown): string | null =>
	typeof value === 'string' && HEX.test(value.trim()) ? value.trim().toLowerCase() : null;

/** The background a Block paints, `undefined` when it paints none, `null` when it cannot be measured. */
function ownBackground(content: Record<string, unknown>): string | null | undefined {
	if (content['backgroundGradient'] || content['backgroundImage']) return null;
	const raw = content['backgroundColor'];
	if (raw === undefined || raw === '' || raw === 'transparent') return undefined;
	return solid(raw);
}

/** A ratio rounded down to one decimal, so 4.47 never reads as "4.5". */
export const formatRatio = (ratio: number) => (Math.floor(ratio * 10) / 10).toFixed(1);

function item(label: string, ratio: number, blockId?: string): PresendItem {
	return {
		label,
		reason: {
			key: 'components.campaigns.presendChecks.reasons.lowContrast',
			params: { ratio: formatRatio(ratio), required: WCAG_AA_CONTRAST },
		},
		...(blockId ? { blockId } : {}),
	};
}

/** Text Blocks whose colour fails AA against their background in the light rendering. */
export function lightContrastItems(
	blocks: readonly EditorBlock[],
	theme: Required<EmailTheme>
): PresendItem[] {
	const items: PresendItem[] = [];
	const visit = (nodes: readonly EditorBlock[], background: string | null) => {
		for (const node of nodes) {
			const content = node.content as unknown as Record<string, unknown>;
			if (node.type === 'button') {
				// The label on the button's own fill (`blockBackgroundColor` is the
				// section around it).
				const fill = content['backgroundGradient'] ? null : solid(content['backgroundColor']);
				const label = solid(content['textColor']);
				if (fill && label) {
					const ratio = getContrastRatio(label, fill);
					if (ratio < WCAG_AA_CONTRAST) items.push(item(`${label} / ${fill}`, ratio, node.id));
				}
				continue;
			}
			const own = ownBackground(content);
			const bg = own === undefined ? background : own;
			if (node.type === 'text' && bg) {
				const color = solid(content['textColor']) ?? solid(theme.bodyTextColor);
				if (color) {
					const ratio = getContrastRatio(color, bg);
					if (ratio < WCAG_AA_CONTRAST) items.push(item(`${color} / ${bg}`, ratio, node.id));
				}
			}
			visit(childBlockLists(node).flat(), bg);
		}
	};
	visit(blocks, solid(theme.backgroundColor));
	return items;
}

/** The dark-mode pairs that fail AA: the theme's own, then text Blocks on light fills. */
export function darkContrastItems(
	blocks: readonly EditorBlock[],
	theme: Required<EmailTheme>
): PresendItem[] {
	const items: PresendItem[] = [];
	const darkBg = solid(theme.darkModeBackgroundColor);
	const darkText = solid(theme.darkModeTextColor);
	const darkLink = solid(theme.darkModeLinkColor);
	if (darkBg && darkText) {
		const ratio = getContrastRatio(darkText, darkBg);
		if (ratio < WCAG_AA_CONTRAST) items.push(item(`${darkText} / ${darkBg}`, ratio));
	}
	if (darkBg && darkLink) {
		const ratio = getContrastRatio(darkLink, darkBg);
		if (ratio < WCAG_AA_CONTRAST) items.push(item(`${darkLink} / ${darkBg}`, ratio));
	}
	if (!darkText) return items;

	const visit = (nodes: readonly EditorBlock[], background: string | null) => {
		for (const node of nodes) {
			const content = node.content as unknown as Record<string, unknown>;
			const own = ownBackground(content);
			// A dark-mode background replaces the fill; without one the light fill
			// stays (only the page background is swapped).
			const bg = solid(content['darkBackgroundColor']) ?? (own === undefined ? background : own);
			if (node.type === 'text' && bg) {
				const ratio = getContrastRatio(darkText, bg);
				if (ratio < WCAG_AA_CONTRAST) items.push(item(`${darkText} / ${bg}`, ratio, node.id));
			}
			visit(childBlockLists(node).flat(), bg);
		}
	};
	visit(blocks, darkBg);
	return items;
}
