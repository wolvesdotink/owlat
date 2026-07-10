/**
 * Column-width math for the `columns` Block — the single source of truth for
 * how a column count + ratio preset maps to per-column width percentages.
 *
 * Consumed by both halves of the Block module: the renderer half (table HTML)
 * and the editor half (canvas preview). Keeping it here stops the two copies
 * from drifting — they previously disagreed on the 4-column narrow ratios, so
 * a narrow 4-column layout rendered differently in the editor than in the
 * sent email.
 *
 * `ratio` is typed as `string` (not `ColumnRatio`) so an unknown preset falls
 * through to the equal-width default rather than failing to compile.
 */
type Ratio = 'equal' | 'left-wide' | 'right-wide' | 'left-narrow' | 'right-narrow';

/**
 * Per-column-count width presets, keyed by [count][ratio]. Each count's `equal`
 * entry doubles as the equal-width fallback for an unknown ratio. The 2-column
 * `left-narrow` / `right-narrow` values are deliberately the mirror of the
 * "wide" variants — do not "simplify" them to match.
 */
const COLUMN_WIDTHS: Record<2 | 3 | 4, Record<Ratio, string[]>> = {
	2: {
		equal: ['50%', '50%'],
		'left-wide': ['67%', '33%'],
		'right-wide': ['33%', '67%'],
		'left-narrow': ['33%', '67%'],
		'right-narrow': ['67%', '33%'],
	},
	3: {
		equal: ['33.33%', '33.33%', '33.33%'],
		'left-wide': ['50%', '25%', '25%'],
		'right-wide': ['25%', '25%', '50%'],
		'left-narrow': ['25%', '37.5%', '37.5%'],
		'right-narrow': ['37.5%', '37.5%', '25%'],
	},
	4: {
		equal: ['25%', '25%', '25%', '25%'],
		'left-wide': ['40%', '20%', '20%', '20%'],
		'right-wide': ['20%', '20%', '20%', '40%'],
		'left-narrow': ['15%', '28.33%', '28.33%', '28.33%'],
		'right-narrow': ['28.33%', '28.33%', '28.33%', '15%'],
	},
};

export const getColumnWidths = (columnCount: 1 | 2 | 3 | 4, ratio: string): string[] => {
	if (columnCount === 1) {
		return ['100%'];
	}
	const byRatio = COLUMN_WIDTHS[columnCount];
	return byRatio[ratio as Ratio] ?? byRatio.equal;
};
