/**
 * Block module: table.
 *
 * Native data table with rich cells (colSpan/rowSpan/per-cell styling),
 * per-column widths, footer rows, captions, and responsive modes
 * (stack / scroll / hide-columns).
 *
 * Root placement only — nesting a data table inside a column or container is
 * possible in theory but pathologically narrow.
 */

import { fullSupport, type TableBlockContent, type TableCell, type TableColumn } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import type { RenderContext } from '../../types';
import { escapeHtml, escapeAttr } from '../../sanitize';
import { stripHtml } from '../../helpers/text';
import { checkShape, isString, isBoolean, isNumber, isArray, isOneOf } from '../../helpers/validation';

const TABLE_ALIGNS = ['left', 'center', 'right'] as const;

const injectResponsiveCss = (content: TableBlockContent, ctx: RenderContext): void => {
	const mode = content.responsiveMode;
	if (mode === 'stack') {
		ctx.responsiveRules.push(
			'.owlat-data-table thead{display:none!important}',
			'.owlat-data-table tr{display:block!important;margin-bottom:8px!important;border:1px solid ' + (content.borderColor || '#e0e0e0') + '!important}',
			'.owlat-data-table td{display:block!important;text-align:right!important;border:none!important;border-bottom:1px solid ' + (content.borderColor || '#e0e0e0') + '!important;position:relative!important;padding-left:50%!important}',
			'.owlat-data-table td:last-child{border-bottom:none!important}',
			'.owlat-data-table td:before{content:attr(data-label);position:absolute!important;left:8px!important;top:8px!important;font-weight:700!important;text-align:left!important}',
		);
	} else if (mode === 'scroll') {
		ctx.responsiveRules.push('.owlat-table-scroll{overflow-x:auto!important;-webkit-overflow-scrolling:touch!important}');
	} else if (mode === 'hide-columns') {
		ctx.responsiveRules.push('.owlat-hide-col{display:none!important}');
	}
};

const renderRichCell = (
	cell: TableCell,
	colIdx: number,
	columns: TableColumn[] | undefined,
	borderStyle: string,
	cellPadding: number,
	defaultAlign: string,
	rowBg: string,
	responsiveMode?: string,
	content?: TableBlockContent,
): string => {
	const colAlign = cell.textAlign || columns?.[colIdx]?.textAlign || defaultAlign;
	const bg = cell.backgroundColor ? `background-color:${cell.backgroundColor};` : rowBg;
	const fw = cell.fontWeight ? `font-weight:${cell.fontWeight};` : '';
	const colSpan = cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
	const rowSpan = cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
	const hideClass = responsiveMode === 'hide-columns' && content?.hideOnMobileColumns?.includes(colIdx) ? ' class="owlat-hide-col"' : '';
	const dataLabel = responsiveMode === 'stack' && content?.headers?.[colIdx]
		? ` data-label="${escapeAttr(content.headers[colIdx])}"`
		: '';
	return `<td${colSpan}${rowSpan}${hideClass}${dataLabel} style="${borderStyle};padding:${cellPadding}px;text-align:${colAlign};${bg}${fw}font-family:inherit">${escapeHtml(cell.content)}</td>`;
};

export const renderTableContent = (content: TableBlockContent, ctx?: RenderContext): string => {
	const cellPadding = content.cellPadding ?? 8;
	const textAlign = content.textAlign || 'left';
	const borderColor = content.borderColor || '#e0e0e0';
	const borderStyle = `border:1px solid ${borderColor}`;
	const headerBg = content.headerBackgroundColor || '#f5f5f5';
	const headerColor = content.headerTextColor || '#333333';
	const stripedBg = content.stripeColor || '#fafafa';
	const columns = content.columns;
	const responsiveMode = content.responsiveMode || 'default';

	if (ctx && responsiveMode !== 'default') injectResponsiveCss(content, ctx);

	const captionHtml = content.captionText
		? `<caption style="text-align:left;caption-side:top;padding:0 0 8px 0;font-family:inherit;font-size:14px;color:#666">${escapeHtml(content.captionText)}</caption>`
		: '';

	let colgroupHtml = '';
	if (columns && columns.length > 0) {
		const cols = columns.map((col) => {
			const width = col.width ? ` width="${col.width}"` : '';
			return `<col${width} />`;
		}).join('');
		colgroupHtml = `<colgroup>${cols}</colgroup>`;
	}

	const headerCells = content.headers
		.map((h, colIdx) => {
			const colAlign = columns?.[colIdx]?.textAlign || textAlign;
			const hideClass = responsiveMode === 'hide-columns' && content.hideOnMobileColumns?.includes(colIdx) ? ' class="owlat-hide-col"' : '';
			return `<th scope="col"${hideClass} style="${borderStyle};padding:${cellPadding}px;text-align:${colAlign};background-color:${headerBg};color:${headerColor};font-family:inherit;font-weight:700">${escapeHtml(h)}</th>`;
		}).join('');
	// nosemgrep -- headerCells already escapeHtml()'s each header's text; the rest is computed style markup. This module IS the HTML renderer.
	const headerRow = content.headers.length > 0 ? `<thead><tr>${headerCells}</tr></thead>` : '';

	let bodyHtml: string;
	if (content.cells && content.cells.length > 0) {
		const dataRows = content.cells.map((row, rowIdx) => {
			const rowBg = content.striped && rowIdx % 2 === 1 ? `background-color:${stripedBg};` : '';
			const cells = row.map((cell, colIdx) => renderRichCell(cell, colIdx, columns, borderStyle, cellPadding, textAlign, rowBg, responsiveMode, content)).join('');
			return `<tr>${cells}</tr>`;
		}).join('');
		bodyHtml = `<tbody>${dataRows}</tbody>`;
	} else {
		const dataRows = content.rows.map((row, rowIdx) => {
			const rowBg = content.striped && rowIdx % 2 === 1 ? `background-color:${stripedBg};` : '';
			const cells = row.map((cell, colIdx) => {
				const colAlign = columns?.[colIdx]?.textAlign || textAlign;
				const hideClass = responsiveMode === 'hide-columns' && content.hideOnMobileColumns?.includes(colIdx) ? ' class="owlat-hide-col"' : '';
				const dataLabel = responsiveMode === 'stack' && content.headers[colIdx] ? ` data-label="${escapeAttr(content.headers[colIdx])}"` : '';
				return `<td${hideClass}${dataLabel} style="${borderStyle};padding:${cellPadding}px;text-align:${colAlign};${rowBg}font-family:inherit">${escapeHtml(cell)}</td>`;
			}).join('');
			return `<tr>${cells}</tr>`;
		}).join('');
		bodyHtml = `<tbody>${dataRows}</tbody>`;
	}

	let footerHtml = '';
	if (content.footerRow && content.footerRow.length > 0) {
		const footerCells = content.footerRow.map((cell, colIdx) => {
			const colAlign = columns?.[colIdx]?.textAlign || textAlign;
			const hideClass = responsiveMode === 'hide-columns' && content.hideOnMobileColumns?.includes(colIdx) ? ' class="owlat-hide-col"' : '';
			return `<td${hideClass} style="${borderStyle};padding:${cellPadding}px;text-align:${colAlign};background-color:${headerBg};color:${headerColor};font-family:inherit;font-weight:700">${escapeHtml(cell)}</td>`;
		}).join('');
		footerHtml = `<tfoot><tr>${footerCells}</tr></tfoot>`;
	}

	const tableHtml = `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" class="owlat-data-table" style="border-collapse:collapse;${borderStyle}">${captionHtml}${colgroupHtml}${headerRow}${bodyHtml}${footerHtml}</table>`;

	if (responsiveMode === 'scroll') {
		return `<div class="owlat-table-scroll" style="width:100%">${tableHtml}</div>`;
	}
	return tableHtml;
};

export const tableModule: BlockModule<'table'> = {
	type: 'table',
	placements: ['root'] as readonly Placement[],

	html({ content, ctx }) {
		return renderTableContent(content, ctx);
	},

	amp({ content }) {
		// The table HTML is pure table markup (no <img>, no scripts) so it is
		// already AMP4Email-valid. We render without a RenderContext, which only
		// omits the responsive media-query rules (those have no AMP equivalent).
		return renderTableContent(content);
	},

	plaintext({ content }) {
		const lines: string[] = [];
		if (content.captionText) {
			lines.push(content.captionText);
			lines.push('');
		}
		if (content.headers.length > 0) {
			lines.push(content.headers.join(' | '));
			lines.push(content.headers.map(() => '---').join(' | '));
		}
		if (content.cells && content.cells.length > 0) {
			for (const row of content.cells) {
				lines.push(row.map((cell) => stripHtml(cell.content)).join(' | '));
			}
		} else {
			for (const row of content.rows) {
				lines.push(row.join(' | '));
			}
		}
		if (content.footerRow && content.footerRow.length > 0) {
			lines.push(content.footerRow.map(() => '---').join(' | '));
			lines.push(content.footerRow.join(' | '));
		}
		return lines.join('\n');
	},

	createDefault() {
		return {
			headers: ['Header 1', 'Header 2', 'Header 3'],
			rows: [
				['Cell 1', 'Cell 2', 'Cell 3'],
				['Cell 4', 'Cell 5', 'Cell 6'],
			],
			headerBackgroundColor: '#f5f5f5',
			headerTextColor: '#333333',
			borderColor: '#e0e0e0',
			striped: true,
			stripeColor: '#fafafa',
			cellPadding: 8,
			textAlign: 'left',
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Basic table rendering',
				description: 'HTML table with headers, rows, borders',
				support: fullSupport,
				fallback: 'N/A — tables are universally supported',
				owlatHandled: false,
				canIEmailSlug: 'html-table',
			},
			{
				feature: 'Responsive reflow',
				description: 'Table columns reflowing on mobile',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					outlookMac: 'none',
					appleMail: 'none',
					iosMail: 'none',
					yahooMail: 'none',
					samsungMail: 'none',
				},
				fallback: 'Tables clip on mobile — keep column count low',
				owlatHandled: false,
				canIEmailSlug: 'css-at-media',
			},
			{
				feature: 'Column span (colspan)',
				description: 'Merging table cells horizontally',
				support: fullSupport,
				fallback: 'N/A — universally supported',
				owlatHandled: false,
			},
			{
				feature: 'Row span (rowspan)',
				description: 'Merging table cells vertically',
				support: fullSupport,
				fallback: 'N/A — universally supported',
				owlatHandled: false,
			},
			{
				feature: 'Table caption',
				description: 'Accessible table caption element',
				support: fullSupport,
				fallback: 'N/A — universally supported',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'headers', check: isArray, code: 'TABLE_HEADERS_TYPE', message: 'headers must be an array' },
			{ field: 'rows', check: isArray, code: 'TABLE_ROWS_TYPE', message: 'rows must be an array' },
			{ field: 'headerBackgroundColor', check: isString, code: 'TABLE_HEADER_BG_TYPE', message: 'headerBackgroundColor must be a string' },
			{ field: 'headerTextColor', check: isString, code: 'TABLE_HEADER_TEXT_TYPE', message: 'headerTextColor must be a string' },
			{ field: 'borderColor', check: isString, code: 'TABLE_BORDER_COLOR_TYPE', message: 'borderColor must be a string' },
			{ field: 'striped', check: isBoolean, code: 'TABLE_STRIPED_TYPE', message: 'striped must be a boolean' },
			{ field: 'stripeColor', check: isString, code: 'TABLE_STRIPE_COLOR_TYPE', message: 'stripeColor must be a string' },
			{ field: 'cellPadding', check: isNumber, code: 'TABLE_CELL_PADDING_TYPE', message: 'cellPadding must be a number' },
			{ field: 'textAlign', check: (v) => isOneOf(v, TABLE_ALIGNS), code: 'TABLE_TEXT_ALIGN_INVALID', message: 'textAlign must be left, center, or right' },
		], block.id, 'table', ctx.issues);

		// Semantic
		if (content.headers.length === 0 && content.rows.length === 0 && (!content.cells || content.cells.length === 0)) {
			ctx.issues.push({ blockId: block.id, blockType: 'table', severity: 'error', code: 'TABLE_EMPTY', message: 'Table block has no headers and no rows' });
		}
		if (content.headers.length > 5) {
			ctx.issues.push({ blockId: block.id, blockType: 'table', severity: 'warning', code: 'TABLE_MANY_COLUMNS', message: `Table has ${content.headers.length} columns — tables wider than 5 columns will clip or overflow on mobile devices` });
		}
		if (ctx.options?.accessibilityAudit && !content.captionText) {
			ctx.issues.push({ blockId: block.id, blockType: 'table', severity: 'info', code: 'A11Y_TABLE_NO_CAPTION', message: 'Table has no caption — consider adding captionText for screen readers' });
		}

		// Outlook
		if (content.responsiveMode === 'stack' || content.responsiveMode === 'scroll') {
			ctx.issues.push({ blockId: block.id, blockType: 'table', severity: 'info', code: 'OUTLOOK_TABLE_RESPONSIVE', message: `Table responsive mode "${content.responsiveMode}" has no effect in Outlook — Outlook always renders the table at full width` });
		}
	},
};
