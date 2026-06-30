/**
 * Block module: progressBar.
 *
 * Single-row, two-cell table where the filled portion is one td and the
 * remaining track is the next. WebKit's anonymous line-box bug means a nested
 * table inside a td doubles in height, so we lay the bar out flat instead.
 */

import { fullSupport, type ProgressBarBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { checkShape, isString, isNumber } from '../../helpers/validation';
import { getContrastRatio } from '../../validators/registry';

export const renderProgressBarContent = (content: ProgressBarBlockContent): string => {
	const maxValue = content.maxValue ?? 100;
	const percentage = Math.min(100, Math.max(0, (content.value / maxValue) * 100));
	const rounded = Math.round(percentage);
	const height = content.height || 20;
	const barColor = content.barColor || '#4CAF50';
	const trackColor = content.trackColor || '#e0e0e0';
	const borderRadius = content.borderRadius ?? 0;

	const showLabel = content.showLabel ?? false;
	const labelPosition = content.labelPosition || 'right';
	const labelColor = content.labelColor || '#333333';
	const labelFontSize = content.labelFontSize ?? 14;
	const labelText = `${rounded}%`;

	const cellBase = `height:${height}px;font-size:0;line-height:0;padding:0;margin:0;`;
	const heightAttr = ` height="${height}"`;

	const rFull = borderRadius > 0 ? `border-radius:${borderRadius}px;` : '';
	const rLeft = borderRadius > 0 ? `border-radius:${borderRadius}px 0 0 ${borderRadius}px;` : '';
	const rRight = borderRadius > 0 ? `border-radius:0 ${borderRadius}px ${borderRadius}px 0;` : '';

	let barRadius: string;
	let trackRadius: string;
	if (rounded >= 100) { barRadius = rFull; trackRadius = ''; }
	else if (rounded <= 0) { barRadius = ''; trackRadius = rFull; }
	else { barRadius = rLeft; trackRadius = rRight; }

	const hasInsideLabel = showLabel && labelPosition === 'inside' && percentage > 15;
	const filler = '&#8203;';

	let barCells: string;
	if (rounded >= 100) {
		barCells = `<td${heightAttr} style="${cellBase}${barRadius}background-color:${barColor};width:100%">${hasInsideLabel ? `<span style="color:#ffffff;font-size:${Math.min(labelFontSize, height - 4)}px;line-height:${height}px;padding:0 8px;font-family:inherit">${labelText}</span>` : filler}</td>`;
	} else if (rounded <= 0) {
		barCells = `<td${heightAttr} style="${cellBase}${trackRadius}background-color:${trackColor};width:100%">${filler}</td>`;
	} else {
		barCells = `<td${heightAttr} style="${cellBase}${barRadius}background-color:${barColor};width:${rounded}%">${hasInsideLabel ? `<span style="color:#ffffff;font-size:${Math.min(labelFontSize, height - 4)}px;line-height:${height}px;padding:0 8px;font-family:inherit">${labelText}</span>` : filler}</td><td${heightAttr} style="${cellBase}${trackRadius}background-color:${trackColor};width:${100 - rounded}%">${filler}</td>`;
	}

	const barHtml = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse"><tr>${barCells}</tr></table>`;

	if (showLabel && labelPosition === 'right') {
		return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:0;vertical-align:middle">${barHtml}</td><td style="width:50px;padding:0 0 0 8px;vertical-align:middle;text-align:right;font-size:${labelFontSize}px;color:${labelColor};font-family:inherit;white-space:nowrap">${labelText}</td></tr></table>`;
	}

	return barHtml;
};

export const progressBarModule: BlockModule<'progressBar'> = {
	type: 'progressBar',
	placements: ['root'] as readonly Placement[],

	html({ content }) {
		return renderProgressBarContent(content);
	},

	amp({ content }) {
		// The progress bar is a flat two-cell table with no images or scripts,
		// so it is already AMP4Email-valid.
		return renderProgressBarContent(content);
	},

	plaintext({ content }) {
		const maxValue = content.maxValue ?? 100;
		const percentage = Math.min(100, Math.max(0, Math.round((content.value / maxValue) * 100)));
		return `[Progress: ${percentage}%]`;
	},

	createDefault(theme) {
		return {
			value: 50,
			barColor: theme.primaryColor ?? '#000000',
			trackColor: '#e0e0e0',
			height: 20,
			borderRadius: 10,
			showLabel: true,
			labelPosition: 'right',
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Table-based progress bar',
				description:
					'Progress bar rendered using nested tables with percentage widths',
				support: fullSupport,
				fallback: 'Progress bar rendered using nested tables',
				owlatHandled: true,
				canIEmailSlug: 'html-table',
			},
			{
				feature: 'Border radius on bar',
				description: 'Rounded ends on the progress bar',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				fallback: 'Square ends in Outlook',
				owlatHandled: false,
				canIEmailSlug: 'css-border-radius',
			},
		],
		properties: [
			{
				property: 'labelPosition',
				description: 'Label position (inside or right)',
				support: fullSupport,
				severity: 'info',
				recommendation:
					'Inside labels may clip on very narrow bars (< 30px height). Use right position for small bars.',
				owlatHandled: false,
				degradationImpact: 'visual',
				fixes: [
					{
						action: 'replace-value',
						property: 'labelPosition',
						suggestedValue: 'right',
						description: 'Move label outside the bar to prevent clipping',
					},
				],
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'value', check: isNumber, code: 'PROGRESS_VALUE_TYPE', message: 'value must be a number' },
			{ field: 'barColor', check: isString, code: 'PROGRESS_BAR_COLOR_TYPE', message: 'barColor must be a string' },
			{ field: 'trackColor', check: isString, code: 'PROGRESS_TRACK_COLOR_TYPE', message: 'trackColor must be a string' },
			{ field: 'height', check: isNumber, code: 'PROGRESS_HEIGHT_TYPE', message: 'height must be a number' },
		], block.id, 'progressBar', ctx.issues);

		// Semantic
		const maxValue = content.maxValue ?? 100;
		if (content.value < 0 || content.value > maxValue) {
			ctx.issues.push({ blockId: block.id, blockType: 'progressBar', severity: 'warning', code: 'PROGRESS_OUT_OF_RANGE', message: `Progress value (${content.value}) is outside expected range 0-${maxValue}` });
		}

		// Accessibility (audit mode)
		if (ctx.options?.accessibilityAudit && content.barColor && content.trackColor) {
			const contrast = getContrastRatio(content.barColor, content.trackColor);
			if (contrast < 3) {
				ctx.issues.push({ blockId: block.id, blockType: 'progressBar', severity: 'warning', code: 'A11Y_PROGRESS_LOW_CONTRAST', message: `Progress bar/track contrast ratio (${contrast.toFixed(1)}:1) is below recommended 3:1` });
			}
		}
	},
};
