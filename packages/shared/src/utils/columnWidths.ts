/**
 * Column-width math for the `columns` Block — the single source of truth for
 * how a column count, a ratio preset and optional custom widths map to
 * per-column width percentages.
 *
 * Consumed by both halves of the Block module: the renderer half (table HTML)
 * and the editor half (canvas preview). Keeping it here stops the two copies
 * from drifting — they previously disagreed on the 4-column narrow ratios, so
 * a narrow 4-column layout rendered differently in the editor than in the
 * sent email.
 *
 * `ratio` is typed as `string` (not `ColumnRatio`) so an unknown preset falls
 * through to the equal-width default rather than failing to compile.
 *
 * Custom widths (`columnWidths` on the content) are whole percentages that sum
 * to exactly 100, one per column, none below {@link MIN_COLUMN_WIDTH_PERCENT}.
 * Whole numbers keep the sum exact, so there is no rounding rule to agree on;
 * a row of thirds uses the `equal` preset. Custom widths that break any of
 * these rules are ignored and the preset applies, so a stored row always
 * renders with widths that fill it.
 */
import type { ColumnCount } from '../types/blockContentBasic';

type Ratio = 'equal' | 'left-wide' | 'right-wide' | 'left-narrow' | 'right-narrow';

/** The most columns a row can hold. */
export const MAX_COLUMN_COUNT = 5;

/**
 * The narrowest custom column. At the default 600px email width this is a
 * 60px column, room for an avatar or an icon next to text. A width in pixels
 * is not offered: the stacking layout sizes inline-block columns in percent,
 * and a fixed column next to a fluid one needs `calc()`, which several email
 * clients drop.
 */
export const MIN_COLUMN_WIDTH_PERCENT = 10;

/**
 * Per-column-count width presets, keyed by [count][ratio]. Each count's `equal`
 * entry doubles as the equal-width fallback for an unknown ratio. The 2-column
 * `left-narrow` / `right-narrow` values are deliberately the mirror of the
 * "wide" variants — do not "simplify" them to match.
 */
const COLUMN_WIDTHS: Record<2 | 3 | 4 | 5, Record<Ratio, string[]>> = {
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
	5: {
		equal: ['20%', '20%', '20%', '20%', '20%'],
		'left-wide': ['40%', '15%', '15%', '15%', '15%'],
		'right-wide': ['15%', '15%', '15%', '15%', '40%'],
		'left-narrow': ['12%', '22%', '22%', '22%', '22%'],
		'right-narrow': ['22%', '22%', '22%', '22%', '12%'],
	},
};

const presetWidths = (columnCount: ColumnCount, ratio: string): string[] => {
	if (columnCount === 1) return ['100%'];
	const byRatio = COLUMN_WIDTHS[columnCount] ?? COLUMN_WIDTHS[2];
	return byRatio[ratio as Ratio] ?? byRatio.equal;
};

/**
 * Whether `widths` are usable custom widths for a row of `columnCount`
 * columns: one whole percentage per column, each at least
 * {@link MIN_COLUMN_WIDTH_PERCENT}, summing to exactly 100.
 */
export const isValidColumnWidths = (widths: unknown, columnCount: unknown): widths is number[] =>
	Array.isArray(widths) &&
	typeof columnCount === 'number' &&
	columnCount >= 1 &&
	columnCount <= MAX_COLUMN_COUNT &&
	widths.length === columnCount &&
	widths.every(
		(width) =>
			typeof width === 'number' && Number.isInteger(width) && width >= MIN_COLUMN_WIDTH_PERCENT
	) &&
	widths.reduce((sum: number, width: number) => sum + width, 0) === 100;

/**
 * The CSS width of each column. Valid custom widths win over the ratio
 * preset; anything else falls back to the preset.
 */
export const getColumnWidths = (
	columnCount: ColumnCount,
	ratio: string,
	columnWidths?: readonly number[]
): string[] => {
	if (isValidColumnWidths(columnWidths, columnCount)) {
		return columnWidths.map((width) => `${width}%`);
	}
	return presetWidths(columnCount, ratio);
};

/**
 * The widths a row shows now, as whole percentages summing to 100: the
 * starting point when someone switches a row to custom widths. Preset
 * fractions (33.33, 28.33) are rounded by largest remainder, so thirds become
 * 34/33/33.
 */
export const getColumnWidthPercents = (
	columnCount: ColumnCount,
	ratio: string,
	columnWidths?: readonly number[]
): number[] => {
	const exact = getColumnWidths(columnCount, ratio, columnWidths).map((width) =>
		Number.parseFloat(width)
	);
	const floors = exact.map(Math.floor);
	let missing = 100 - floors.reduce((sum, width) => sum + width, 0);
	const byRemainder = exact
		.map((width, index) => ({ index, remainder: width - Math.floor(width) }))
		.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (const { index } of byRemainder) {
		if (missing <= 0) break;
		floors[index] = (floors[index] ?? 0) + 1;
		missing--;
	}
	return floors;
};

/**
 * Set one column's width and take the difference from the other columns, so
 * the row still sums to 100 and no column drops below the minimum. The column
 * after the edited one absorbs the change first (the one before it, for the
 * last column); when it reaches the minimum, the next one in line gives way.
 */
export const setColumnWidth = (
	widths: readonly number[],
	index: number,
	value: number
): number[] => {
	const count = widths.length;
	const max = 100 - MIN_COLUMN_WIDTH_PERCENT * (count - 1);
	const target = Math.min(max, Math.max(MIN_COLUMN_WIDTH_PERCENT, Math.round(value)));
	const next = [...widths];
	if (index < 0 || index >= count || !Number.isFinite(value)) return next;
	next[index] = target;

	const others = [
		...Array.from({ length: count - index - 1 }, (_, i) => index + 1 + i),
		...Array.from({ length: index }, (_, i) => index - 1 - i),
	];
	let excess = next.reduce((sum, width) => sum + width, 0) - 100;
	if (excess < 0) {
		const neighbour = others[0];
		if (neighbour !== undefined) next[neighbour] = (next[neighbour] ?? 0) - excess;
		return next;
	}
	for (const other of others) {
		if (excess <= 0) break;
		const give = Math.min(excess, (next[other] ?? 0) - MIN_COLUMN_WIDTH_PERCENT);
		if (give <= 0) continue;
		next[other] = (next[other] ?? 0) - give;
		excess -= give;
	}
	return next;
};
