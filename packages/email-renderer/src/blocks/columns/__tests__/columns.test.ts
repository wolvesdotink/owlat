import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../../../renderer';
import { renderPlainText } from '../../../plaintext';
import { renderAmpEmail } from '../../../amp';
import { validateBlocks } from '../../../validator';
import type { EditorBlock, ColumnsBlockContent, TextBlockContent } from '@owlat/shared';

describe('Enhanced Columns Block', () => {
	const makeColumnsBlock = (content: Partial<ColumnsBlockContent>): EditorBlock => ({
		id: 'cols-1',
		type: 'columns',
		content: {
			columnCount: 2,
			ratio: 'equal',
			mobileStacking: true,
			columns: [
				[
					{
						id: 'col-item-1',
						type: 'text',
						content: {
							html: '<p>Left column</p>',
							blockType: 'paragraph',
							fontSize: 16,
							textColor: '#333',
						} as TextBlockContent,
					},
				],
				[
					{
						id: 'col-item-2',
						type: 'text',
						content: {
							html: '<p>Right column</p>',
							blockType: 'paragraph',
							fontSize: 16,
							textColor: '#333',
						} as TextBlockContent,
					},
				],
			],
			...content,
		} as ColumnsBlockContent,
	});

	it('should render reverse mobile stacking with CSS classes', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStackOrder: 'reverse' })], {
			inlineCss: false,
		});
		expect(html).toContain('owlat-col-rev-');
		// Each reversed column gets its table-footer-group rule.
		expect(html).toContain('.owlat-col-rev-0{display:table-footer-group!important;}');
		expect(html).toContain('.owlat-col-rev-1{display:table-footer-group!important;}');
	});

	it('should render normal stacking without reverse classes', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStackOrder: 'normal' })], {
			inlineCss: false,
		});
		expect(html).not.toContain('owlat-col-rev-');
	});

	it('should respect per-column stackOnMobile override', () => {
		const html = renderEmailHtml(
			[
				makeColumnsBlock({
					columnStyles: [{ stackOnMobile: false }, { stackOnMobile: true }],
				}),
			],
			{ inlineCss: false }
		);
		// First column should NOT have owlat-col class (non-stacking)
		// Second column should have owlat-col class (stacking)
		const matches = html.match(/class="owlat-col"/g) || [];
		expect(matches.length).toBe(1); // Only second column stacks
	});

	it('should render non-stacking columns with table-cell display', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStacking: false })], {
			inlineCss: false,
		});
		expect(html).toContain('display:table-cell');
	});

	it('puts non-stacking columns in a full-width table row so they keep their widths', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStacking: false })], {
			inlineCss: false,
		});
		expect(html).toContain('<div style="display:table;width:100%;font-size:0;line-height:0;">');
	});

	it('lets a column that opts into stacking leave a non-stacking row on mobile', () => {
		const html = renderEmailHtml(
			[
				makeColumnsBlock({
					mobileStacking: false,
					columnStyles: [{}, { stackOnMobile: true }],
				}),
			],
			{ inlineCss: false }
		);
		expect(html).toContain('<div class="owlat-cols-row" style="display:table;');
		expect(html).toContain('.owlat-cols-row{display:block!important}');
	});

	it('leaves the stacking row a plain block', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStacking: true })], {
			inlineCss: false,
		});
		expect(html).not.toContain('display:table;');
	});

	const textItem = (id: string, text: string) => ({
		id,
		type: 'text' as const,
		content: {
			html: `<p>${text}</p>`,
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#333',
		} as TextBlockContent,
	});

	const fiveColumns = (content: Partial<ColumnsBlockContent> = {}) =>
		makeColumnsBlock({
			columnCount: 5,
			columns: [1, 2, 3, 4, 5].map((n) => [textItem(`star-${n}`, `Star ${n}`)]),
			...content,
		});

	/** The Outlook cell widths, in document order. */
	const msoWidths = (html: string) =>
		[...html.matchAll(/<!--\[if mso\]><td width="(\d+)"/g)].map((m) => Number(m[1]));
	/** The CSS width and max-width of each column div, in document order. */
	const columnCss = (html: string) =>
		[
			...html.matchAll(/display:(?:inline-block|table-cell);width:([\d.]+%);max-width:(\d+)px/g),
		].map((m) => `${m[1]} ${m[2]}px`);

	describe('custom widths', () => {
		it('renders a 15/85 row at those widths, with Outlook cells in pixels', () => {
			const html = renderEmailHtml([makeColumnsBlock({ columnWidths: [15, 85] })], {
				inlineCss: false,
			});
			expect(columnCss(html)).toEqual(['15% 90px', '85% 510px']);
			expect(msoWidths(html)).toEqual([90, 510]);
		});

		it('renders a 40/60 row without stacking as table cells at those widths', () => {
			const html = renderEmailHtml(
				[makeColumnsBlock({ columnWidths: [40, 60], mobileStacking: false })],
				{ inlineCss: false }
			);
			expect(html).toContain('display:table-cell;width:40%;max-width:240px');
			expect(html).toContain('display:table-cell;width:60%;max-width:360px');
			expect(msoWidths(html)).toEqual([240, 360]);
		});

		it('custom widths win over the ratio preset', () => {
			const html = renderEmailHtml(
				[makeColumnsBlock({ ratio: 'left-wide', columnWidths: [40, 60] })],
				{ inlineCss: false }
			);
			expect(msoWidths(html)).toEqual([240, 360]);
		});

		it('falls back to the ratio preset when the custom widths do not fill the row', () => {
			const html = renderEmailHtml(
				[makeColumnsBlock({ ratio: 'left-wide', columnWidths: [40, 50] })],
				{ inlineCss: false }
			);
			expect(columnCss(html)).toEqual(['67% 402px', '33% 198px']);
		});

		it('renders a row without custom widths exactly as before', () => {
			const html = renderEmailHtml([makeColumnsBlock({ ratio: 'left-wide' })], {
				inlineCss: false,
			});
			expect(columnCss(html)).toEqual(['67% 402px', '33% 198px']);
			expect(msoWidths(html)).toEqual([402, 198]);
		});

		it('keeps custom widths in an RTL row with the columns reversed', () => {
			const html = renderEmailHtml(
				[makeColumnsBlock({ columnWidths: [15, 85], direction: 'rtl' })],
				{ inlineCss: false }
			);
			expect(msoWidths(html)).toEqual([510, 90]);
		});
	});

	describe('five columns', () => {
		it('renders five equal columns of 120px at the 600px email width', () => {
			const html = renderEmailHtml([fiveColumns()], { inlineCss: false });
			expect(columnCss(html)).toEqual(Array(5).fill('20% 120px'));
			expect(msoWidths(html)).toEqual([120, 120, 120, 120, 120]);
			for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`Star ${n}`);
		});

		it('stacks all five columns on mobile, or keeps them in one row', () => {
			const stacked = renderEmailHtml([fiveColumns()], { inlineCss: false });
			expect(stacked.match(/class="owlat-col"/g)).toHaveLength(5);
			const row = renderEmailHtml([fiveColumns({ mobileStacking: false })], {
				inlineCss: false,
			});
			expect(row.match(/display:table-cell/g)).toHaveLength(5);
			expect(row).not.toContain('class="owlat-col"');
		});

		it('takes custom widths for five columns', () => {
			const html = renderEmailHtml([fiveColumns({ columnWidths: [10, 10, 10, 10, 60] })], {
				inlineCss: false,
			});
			expect(msoWidths(html)).toEqual([60, 60, 60, 60, 360]);
		});

		it('includes the fifth column in the plain text and AMP output', () => {
			expect(renderPlainText([fiveColumns()])).toContain('Star 5');
			expect(renderAmpEmail([fiveColumns()])).toContain('Star 5');
		});
	});

	describe('validation', () => {
		const codes = (block: EditorBlock) => validateBlocks([block]).issues.map((i) => i.code);

		it('accepts five columns and rejects six', () => {
			expect(codes(fiveColumns())).not.toContain('COLUMNS_COUNT_INVALID');
			expect(
				codes(fiveColumns({ columnCount: 6 as ColumnsBlockContent['columnCount'] }))
			).toContain('COLUMNS_COUNT_INVALID');
		});

		it('accepts valid custom widths', () => {
			expect(codes(makeColumnsBlock({ columnWidths: [15, 85] }))).not.toContain(
				'COLUMNS_WIDTHS_INVALID'
			);
		});

		it('flags custom widths of the wrong length, sum or minimum', () => {
			for (const columnWidths of [[100], [40, 50], [5, 95], [33.5, 66.5]]) {
				expect(codes(makeColumnsBlock({ columnWidths }))).toContain('COLUMNS_WIDTHS_INVALID');
			}
		});
	});
});
