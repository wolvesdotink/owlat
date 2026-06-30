import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../../../renderer';
import type { EditorBlock, TableBlockContent, TableCell, TableColumn } from '@owlat/shared';

describe('Enhanced Table Block', () => {
	const makeTableBlock = (content: Partial<TableBlockContent>): EditorBlock => ({
		id: 'table-1',
		type: 'table',
		content: {
			headers: ['Name', 'Amount', 'Status'],
			rows: [
				['Item 1', '$100', 'Paid'],
				['Item 2', '$200', 'Pending'],
			],
			headerBackgroundColor: '#f5f5f5',
			headerTextColor: '#333333',
			borderColor: '#e0e0e0',
			striped: false,
			stripeColor: '#fafafa',
			cellPadding: 8,
			textAlign: 'left',
			...content,
		} as TableBlockContent,
	});

	it('should render rich cells with colSpan', () => {
		const cells: TableCell[][] = [
			[
				{ content: 'Full Width', colSpan: 3, fontWeight: 700 },
			],
			[
				{ content: 'A' },
				{ content: 'B' },
				{ content: 'C' },
			],
		];
		const html = renderEmailHtml([makeTableBlock({ cells, rows: [] })], { inlineCss: false });
		expect(html).toContain('colspan="3"');
		expect(html).toContain('font-weight:700');
		expect(html).toContain('Full Width');
	});

	it('should render rich cells with rowSpan', () => {
		const cells: TableCell[][] = [
			[
				{ content: 'Spans 2 rows', rowSpan: 2 },
				{ content: 'B1' },
			],
			[
				{ content: 'B2' },
			],
		];
		const html = renderEmailHtml([makeTableBlock({ cells, rows: [] })], { inlineCss: false });
		expect(html).toContain('rowspan="2"');
	});

	it('should render per-cell background color', () => {
		const cells: TableCell[][] = [
			[
				{ content: 'Highlighted', backgroundColor: '#ffff00' },
				{ content: 'Normal' },
			],
		];
		const html = renderEmailHtml([makeTableBlock({ cells, rows: [] })], { inlineCss: false });
		expect(html).toContain('background-color:#ffff00');
	});

	it('should render per-column widths', () => {
		const columns: TableColumn[] = [
			{ width: '40%' },
			{ width: '30%', textAlign: 'right' },
			{ width: '30%' },
		];
		const html = renderEmailHtml([makeTableBlock({ columns })], { inlineCss: false });
		expect(html).toContain('<colgroup>');
		expect(html).toContain('width="40%"');
	});

	it('should render per-column text alignment', () => {
		const columns: TableColumn[] = [
			{ textAlign: 'left' },
			{ textAlign: 'right' },
		];
		const html = renderEmailHtml([makeTableBlock({
			columns,
			headers: ['Name', 'Amount'],
			rows: [['Item', '$100']],
		})], { inlineCss: false });
		expect(html).toContain('text-align:right');
	});

	it('should render footer row', () => {
		const html = renderEmailHtml([makeTableBlock({
			footerRow: ['Total', '', '$300'],
		})], { inlineCss: false });
		expect(html).toContain('<tfoot>');
		expect(html).toContain('Total');
		expect(html).toContain('$300');
	});

	it('should render table caption', () => {
		const html = renderEmailHtml([makeTableBlock({
			captionText: 'Order Summary',
		})], { inlineCss: false });
		expect(html).toContain('<caption');
		expect(html).toContain('Order Summary');
	});

	it('should still render simple string rows (backwards compatible)', () => {
		const html = renderEmailHtml([makeTableBlock({})], { inlineCss: false });
		expect(html).toContain('Item 1');
		expect(html).toContain('$200');
		expect(html).toContain('Pending');
	});
});
