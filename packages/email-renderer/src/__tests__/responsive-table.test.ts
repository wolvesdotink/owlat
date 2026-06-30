import { describe, it, expect } from 'vitest';
import { renderEmailHtml, renderBlockFragment } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Responsive Table Reflow', () => {
	const tableBlock: EditorBlock = {
		id: 'tbl-1',
		type: 'table',
		content: {
			headers: ['Name', 'Price', 'Qty'],
			rows: [
				['Widget A', '$10', '5'],
				['Widget B', '$20', '3'],
			],
			headerBackgroundColor: '#f5f5f5',
			headerTextColor: '#333',
			borderColor: '#e0e0e0',
			striped: true,
			stripeColor: '#fafafa',
			cellPadding: 8,
			textAlign: 'left',
		},
	};

	it('default mode renders basic table', () => {
		const html = renderBlockFragment(tableBlock);
		expect(html).toContain('<table');
		expect(html).toContain('Name');
		expect(html).not.toContain('data-label');
	});

	it('stack mode adds data-label attributes', () => {
		const block = {
			...tableBlock,
			content: { ...tableBlock.content, responsiveMode: 'stack' as const },
		};
		const html = renderEmailHtml([block]);
		expect(html).toContain('data-label="Name"');
		expect(html).toContain('data-label="Price"');
		expect(html).toContain('data-label="Qty"');
		// Should inject responsive CSS rules
		expect(html).toContain('owlat-data-table');
	});

	it('scroll mode wraps table in scrollable div', () => {
		const block = {
			...tableBlock,
			content: { ...tableBlock.content, responsiveMode: 'scroll' as const },
		};
		const html = renderEmailHtml([block]);
		expect(html).toContain('owlat-table-scroll');
		expect(html).toContain('overflow-x');
	});

	it('hide-columns mode adds hide class to marked columns', () => {
		const block = {
			...tableBlock,
			content: {
				...tableBlock.content,
				responsiveMode: 'hide-columns' as const,
				hideOnMobileColumns: [2], // hide Qty column
			},
		};
		const html = renderBlockFragment(block);
		expect(html).toContain('owlat-hide-col');
	});
});
