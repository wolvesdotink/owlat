/**
 * Block module: spacer.
 *
 * Emits vertical whitespace via a height-styled table cell — the only reliable
 * way to force vertical space in Outlook (margin/padding on empty divs is
 * unreliable). The cell IS the spacer; no inner content needed at any placement.
 */

import { fullSupport, type SpacerBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { checkShape, isNumber } from '../../helpers/validation';

const renderSpacer = (content: SpacerBlockContent): string =>
	`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" aria-hidden="true"><tr><td style="height:${content.height}px;mso-height-rule:exactly;line-height:${content.height}px;font-size:1px">&nbsp;</td></tr></table>`;

export const spacerModule: BlockModule<'spacer'> = {
	type: 'spacer',
	placements: ['root', 'column', 'container'] as readonly Placement[],

	/**
	 * Spacer renders identically at every placement — the height-styled cell
	 * is both the structure and the content. Wrapping it would add unwanted
	 * padding around the gap.
	 */
	html({ content }) {
		return renderSpacer(content);
	},

	/** Spacer is purely visual — no plain text contribution. */
	plaintext() {
		return '';
	},

	amp({ content }) {
		return `<div style="height:${content.height}px"></div>`;
	},

	createDefault() {
		return { height: 20 };
	},

	compatibility: {
		features: [
			{
				feature: 'Fixed height spacing',
				description: 'Precise vertical spacing',
				support: fullSupport,
				fallback: 'Owlat sets mso-height-rule:exactly for precise Outlook spacing',
				owlatHandled: true,
				canIEmailSlug: 'css-height',
			},
		],
		properties: [
			{
				property: 'height',
				description: 'Spacer height with mso-height-rule',
				support: fullSupport,
				severity: 'info',
				recommendation: 'Owlat sets mso-height-rule:exactly for precise Outlook rendering',
				owlatHandled: true,
			},
		],
	},

	validate({ block, content, ctx }) {
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'height', check: isNumber, code: 'SPACER_HEIGHT_TYPE', message: 'height must be a number' },
		], block.id, 'spacer', ctx.issues);
	},
};
