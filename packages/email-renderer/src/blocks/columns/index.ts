/**
 * Block module: columns.
 *
 * Multi-column layout with mobile stacking, RTL ordering, optional gaps and
 * per-column styling (background, border, padding, background image). Uses
 * MSO conditional comments so Outlook gets a `<table>`-based row while
 * non-Outlook clients get an inline-block / table-cell `<div>` row.
 *
 * Children are dispatched via `args.walk` at the `column` placement so each
 * primitive renders its column-cell shell.
 */

import { fullSupport } from '@owlat/shared';
import { itemToBlock, type BlockModule, type Placement } from '../_module';
import { toPixelWidth, toPercentNumber } from '../../helpers/dimensions';
import { getColumnWidths } from '../../helpers/table';
import { msoColumnsOpen, msoColumnCellOpen, msoColumnCellClose, msoColumnsClose } from '../../outlook';
import { escapeCssUrl } from '../../sanitize';
import { backgroundImageCss } from '../../helpers/inline-styles';
import { checkShape, isString, isBoolean, isNumber, isArray, isObject } from '../../helpers/validation';

export const columnsModule: BlockModule<'columns'> = {
	type: 'columns',
	placements: ['root', 'container'] as readonly Placement[],

	isEmpty(content) {
		return content.columns.every((col) => col.length === 0);
	},

	html({ content, ctx, walk }) {
		const widths = getColumnWidths(content.columnCount, content.ratio);
		const verticalAlign = content.verticalAlign || 'top';
		const gap = content.columnGap ?? 0;
		const gapLeft = Math.floor(gap / 2);
		const gapRight = gap - gapLeft;
		const direction = content.direction || ctx.direction;
		const mobileStackOrder = content.mobileStackOrder || 'normal';

		let columnIndices = Array.from({ length: content.columnCount }, (_, i) => i);
		if (direction === 'rtl') columnIndices = columnIndices.reverse();

		const useTableCell = !content.mobileStacking;

		const columnHtmlParts = columnIndices.map((colIdx) => {
			const columnItems = content.columns[colIdx] || [];
			const width = widths[colIdx] || '100%';
			const widthPercent = toPercentNumber(width, 100);
			const columnBaseWidth = toPixelWidth(widthPercent, ctx.baseWidth);

			const itemsHtml = columnItems
				.map((item) => walk(itemToBlock(item), columnBaseWidth, 'column'))
				.join('');

			const colStyle = content.columnStyles?.[colIdx];
			const columnStacks = colStyle?.stackOnMobile ?? content.mobileStacking;
			const mobileClass = columnStacks ? ' class="owlat-col"' : '';

			const colBg = colStyle?.backgroundColor ? `background-color:${colStyle.backgroundColor};` : '';
			const colVAlign = colStyle?.verticalAlign || verticalAlign;
			const colPaddingTop = colStyle?.paddingTop ?? 0;
			const colPaddingRight = colStyle?.paddingRight ?? gapRight;
			const colPaddingBottom = colStyle?.paddingBottom ?? 0;
			const colPaddingLeft = colStyle?.paddingLeft ?? gapLeft;
			const colPadding = (colPaddingTop || colPaddingRight || colPaddingBottom || colPaddingLeft)
				? `padding:${colPaddingTop}px ${colPaddingRight}px ${colPaddingBottom}px ${colPaddingLeft}px;`
				: gap > 0 ? `padding:0 ${gapLeft}px 0 ${gapRight}px;` : '';

			const colBorderWidth = colStyle?.borderWidth ?? 0;
			const colBorderStyle = colStyle?.borderStyle ?? 'none';
			const colBorderColor = colStyle?.borderColor ?? '#000000';
			const colBorder = colBorderWidth > 0 && colBorderStyle !== 'none'
				? `border:${colBorderWidth}px ${colBorderStyle} ${colBorderColor};`
				: '';
			const colBorderRadius = colStyle?.borderRadius ? `border-radius:${colStyle.borderRadius}px;` : '';
			const colBgImage = colStyle?.backgroundImage
				? backgroundImageCss(
						escapeCssUrl(colStyle.backgroundImage),
						colStyle.backgroundPosition || 'center',
						colStyle.backgroundSize || 'cover',
						'size-position',
					)
				: '';

			const msoWidth = toPixelWidth(widthPercent, ctx.baseWidth);

			const displayStyle = useTableCell
				? `display:table-cell;width:${width};max-width:${msoWidth}px;vertical-align:${colVAlign};box-sizing:border-box;`
				: `display:inline-block;width:${width};max-width:${msoWidth}px;vertical-align:${colVAlign};box-sizing:border-box;font-size:14px;`;

			return `${msoColumnCellOpen(msoWidth, colVAlign)}<div${mobileClass} style="${displayStyle}${colBg}${colBgImage}${colPadding}${colBorder}${colBorderRadius}">${itemsHtml || '&nbsp;'}</div>${msoColumnCellClose()}`;
		});

		if (content.mobileStacking && mobileStackOrder === 'reverse') {
			columnIndices.forEach((colIdx) => {
				ctx.responsiveRules.push(`.owlat-col-rev-${colIdx}{display:table-footer-group!important;}`);
			});
			const reversedParts = columnHtmlParts.map((html, i) => {
				const colIdx = columnIndices[i];
				return html.replace('class="owlat-col"', `class="owlat-col owlat-col-rev-${colIdx}"`);
			});
			const reversedInner = reversedParts.join('');
			return `${msoColumnsOpen(ctx.baseWidth, direction)}<div style="font-size:0;line-height:0;">${reversedInner}</div>${msoColumnsClose()}`;
		}

		const inner = columnHtmlParts.join('');
		return `${msoColumnsOpen(ctx.baseWidth, direction)}<div style="font-size:0;line-height:0;">${inner}</div>${msoColumnsClose()}`;
	},

	plaintext({ content, walk }) {
		const parts: string[] = [];
		for (const column of content.columns) {
			for (const item of column) {
				const text = walk(itemToBlock(item));
				if (text) parts.push(text);
			}
		}
		return parts.join('\n');
	},

	amp({ content, walk }) {
		// AMP4Email has no float/inline-block guarantees across clients, so we
		// stack columns vertically (the same as the mobile layout) and recurse
		// each column's items via `walk` rather than collapsing to an empty
		// comment. Children render their own AMP output.
		const columns = content.columns
			.slice(0, content.columnCount)
			.map((column) => {
				const itemsHtml = column
					.map((item) => walk(itemToBlock(item)))
					.filter(Boolean)
					.join('\n');
				return itemsHtml ? `<div>${itemsHtml}</div>` : '';
			})
			.filter(Boolean)
			.join('\n');
		return columns ? `<div>${columns}</div>` : '';
	},

	createDefault() {
		return {
			columnCount: 2,
			ratio: 'equal',
			mobileStacking: true,
			columns: [[], []],
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Multi-column layout',
				description: 'Side-by-side column layout',
				support: fullSupport,
				fallback: 'Owlat uses MSO conditional tables for fixed column layout in Outlook',
				owlatHandled: true,
			},
			{
				feature: 'Background image on column',
				description: 'CSS background-image on individual columns',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				fallback:
					'Falls back to backgroundColor in Outlook (CSS-only, no VML — column height is content-driven)',
				owlatHandled: false,
				canIEmailSlug: 'css-background-image',
			},
			{
				feature: 'Mobile stacking',
				description: 'Columns stack vertically on mobile',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback: 'Outlook keeps side-by-side layout',
				owlatHandled: false,
				canIEmailSlug: 'css-at-media',
			},
			{
				feature: 'Column gap',
				description: 'Spacing between columns',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback: 'Outlook ignores padding-based gap',
				owlatHandled: false,
			},
			{
				feature: 'Column border-radius',
				description: 'Rounded corners on individual columns',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				fallback: 'Square corners in Outlook',
				owlatHandled: false,
				canIEmailSlug: 'css-border-radius',
			},
			{
				feature: 'Reverse mobile stacking',
				description:
					'Columns stack in reverse order on mobile using display:table-header/footer-group',
				support: {
					...fullSupport,
					gmail: 'partial',
					gmailApp: 'partial',
					outlookDesktop: 'none',
					yahooMail: 'partial',
				},
				fallback: 'Normal stacking order in unsupported clients',
				owlatHandled: true,
			},
			{
				feature: 'Non-stacking columns',
				description: 'Per-column opt-out from mobile stacking using table-cell display',
				support: { ...fullSupport, outlookDesktop: 'none' },
				fallback:
					'Outlook always renders side-by-side (which is the desired behavior)',
				owlatHandled: true,
			},
			{
				feature: 'verticalAlign',
				description: 'Vertical alignment of column content',
				support: fullSupport,
				fallback: 'Owlat uses MSO valign attribute for Outlook vertical alignment',
				owlatHandled: true,
				canIEmailSlug: 'css-vertical-align',
			},
		],
		properties: [
			{
				property: 'mobileStacking',
				description: 'Columns stack vertically on mobile',
				support: { ...fullSupport, outlookDesktop: 'none' },
				severity: 'info',
				recommendation:
					'Outlook always renders side-by-side — design content to work in both layouts',
				owlatHandled: true,
			},
			{
				property: 'columnGap',
				description: 'Spacing between columns',
				support: { ...fullSupport, outlookDesktop: 'none' },
				severity: 'info',
				recommendation:
					'Outlook ignores padding-based gap — columns appear tighter',
				owlatHandled: false,
			},
			{
				property: 'columnStyles.backgroundImage',
				description: 'Background image on individual columns',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				severity: 'warning',
				recommendation: 'Set a solid backgroundColor as fallback for Outlook',
				owlatHandled: false,
				degradationImpact: 'visual',
				fixes: [
					{
						action: 'set-fallback',
						property: 'columnStyles.backgroundColor',
						description: 'Set a solid background color as Outlook fallback',
					},
				],
			},
			{
				property: 'columnStyles.borderRadius',
				description: 'Rounded corners on individual columns',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				severity: 'info',
				recommendation: 'Square corners in Outlook — acceptable for most designs',
				owlatHandled: false,
			},
			{
				property: 'mobileStackOrder',
				description: 'Reverse stacking order on mobile',
				support: {
					...fullSupport,
					gmail: 'partial',
					gmailApp: 'partial',
					outlookDesktop: 'none',
					yahooMail: 'partial',
				},
				severity: 'info',
				recommendation:
					'Normal stacking order in Gmail and Outlook. Design content to be readable in either order.',
				owlatHandled: true,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		const ic = content as unknown as Record<string, unknown>;
		checkShape(ic, [
			{ field: 'columnCount', check: (v) => isNumber(v) && [1, 2, 3, 4].includes(v), code: 'COLUMNS_COUNT_INVALID', message: 'columnCount must be 1, 2, 3, or 4' },
			{ field: 'ratio', check: isString, code: 'COLUMNS_RATIO_TYPE', message: 'ratio must be a string' },
			{ field: 'mobileStacking', check: isBoolean, code: 'COLUMNS_STACKING_TYPE', message: 'mobileStacking must be a boolean' },
			{ field: 'columns', check: isArray, code: 'COLUMNS_COLUMNS_TYPE', message: 'columns must be an array' },
		], block.id, 'columns', ctx.issues);

		if (isArray(ic['columns'])) {
			for (let colIdx = 0; colIdx < (ic['columns'] as unknown[]).length; colIdx++) {
				const col = (ic['columns'] as unknown[])[colIdx];
				if (!isArray(col)) {
					ctx.issues.push({ blockId: block.id, blockType: 'columns', severity: 'error', code: 'COLUMNS_COLUMN_NOT_ARRAY', message: `column ${colIdx} must be an array` });
					continue;
				}
				for (let itemIdx = 0; itemIdx < col.length; itemIdx++) {
					const item = col[itemIdx];
					if (!isObject(item) || !isString(item['id']) || !isString(item['type'])) {
						ctx.issues.push({ blockId: block.id, blockType: 'columns', severity: 'error', code: 'COLUMNS_ITEM_SHAPE', message: `column item ${colIdx}[${itemIdx}] must have id and type strings` });
					}
				}
			}
		}

		// Semantic
		const allEmpty = content.columns.slice(0, content.columnCount).every((col) => col.length === 0);
		if (allEmpty) {
			ctx.issues.push({ blockId: block.id, blockType: 'columns', severity: 'warning', code: 'COLUMNS_ALL_EMPTY', message: 'All columns are empty' });
		}

		// Outlook: column background images have no VML fallback
		if (content.columnStyles) {
			for (let i = 0; i < content.columnStyles.length; i++) {
				const colStyle = content.columnStyles[i];
				if (colStyle?.backgroundImage) {
					ctx.issues.push({ blockId: block.id, blockType: 'columns', severity: 'warning', code: 'OUTLOOK_COLUMN_BG_IMAGE', message: `Column ${i + 1} has a background image — Outlook ignores CSS background-image on table cells. Set a solid backgroundColor as fallback.` });
				}
			}
		}
	},
};
