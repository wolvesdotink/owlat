/**
 * Block module: divider.
 *
 * Renders a horizontal rule as a thin-bordered single-cell table (the only
 * reliable way to get a styled divider across email clients).
 */

import { fullSupport, type DividerBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { escapeAttr, escapeCss } from '../../sanitize';
import { px } from '../../helpers/padding';
import { checkShape, isString, isNumber, isOneOf } from '../../helpers/validation';

const DIVIDER_STYLES = ['solid', 'dashed', 'dotted'] as const;

/** Style values shared by every placement, each escaped or coerced. */
const dividerParts = (content: DividerBlockContent) => ({
	style: escapeCss(content.style || 'solid'),
	align: escapeAttr(content.align || 'center'),
	width: px(content.width, 100),
	thickness: px(content.thickness, 1),
});

const renderInner = (content: DividerBlockContent): string => {
	const { style, align, width, thickness } = dividerParts(content);
	return `<table width="${width}%" cellpadding="0" cellspacing="0" border="0" role="presentation" align="${align}" aria-hidden="true"><tr><td style="border-top:${thickness}px ${style} ${escapeCss(content.color)};font-size:1px;line-height:1px">&nbsp;</td></tr></table>`;
};

/** Column / container placement wraps the inner table in a padding cell. */
const renderInColumn = (content: DividerBlockContent): string => {
	const { style, align, width, thickness } = dividerParts(content);
	return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:8px 0"><table width="${width}%" cellpadding="0" cellspacing="0" border="0" role="presentation" align="${align}"><tr><td style="border-top:${thickness}px ${style} ${escapeCss(content.color)};font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr></table>`;
};

export const dividerModule: BlockModule<'divider'> = {
	type: 'divider',
	placements: ['root', 'column', 'container'] as readonly Placement[],

	html({ content, placement }) {
		return placement === 'root' ? renderInner(content) : renderInColumn(content);
	},

	plaintext() {
		return '---';
	},

	amp({ content }) {
		const { style, width, thickness } = dividerParts(content);
		return `<hr style="border:none;border-top:${thickness}px ${style} ${escapeAttr(content.color)};width:${width}%">`;
	},

	createDefault() {
		return { color: '#282D3A', thickness: 1, width: 100, style: 'solid' };
	},

	compatibility: {
		features: [
			{
				feature: 'Border styles',
				description: 'Solid, dashed, dotted border styles',
				support: fullSupport,
				fallback: 'N/A — universally supported',
				owlatHandled: false,
				canIEmailSlug: 'html-hr',
			},
		],
		properties: [
			{
				property: 'style',
				description: 'Border style (dotted rendering varies)',
				support: { ...fullSupport, outlookDesktop: 'buggy' },
				severity: 'info',
				recommendation:
					'Dotted and dashed styles may render differently in Outlook — solid is most reliable',
				owlatHandled: false,
				degradationImpact: 'visual',
			},
		],
	},

	validate({ block, content, ctx }) {
		checkShape(
			content as unknown as Record<string, unknown>,
			[
				{
					field: 'color',
					check: isString,
					code: 'DIVIDER_COLOR_TYPE',
					message: 'color must be a string',
				},
				{
					field: 'thickness',
					check: isNumber,
					code: 'DIVIDER_THICKNESS_TYPE',
					message: 'thickness must be a number',
				},
				{
					field: 'width',
					check: isNumber,
					code: 'DIVIDER_WIDTH_TYPE',
					message: 'width must be a number',
				},
				{
					field: 'style',
					check: (v) => isOneOf(v, DIVIDER_STYLES),
					code: 'DIVIDER_STYLE_INVALID',
					message: 'style must be solid, dashed, or dotted',
				},
			],
			block.id,
			'divider',
			ctx.issues
		);
	},
};
