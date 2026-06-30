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
export const getColumnWidths = (columnCount: 1 | 2 | 3 | 4, ratio: string): string[] => {
	if (columnCount === 1) {
		return ['100%'];
	}

	if (columnCount === 2) {
		switch (ratio) {
			case 'equal':
				return ['50%', '50%'];
			case 'left-wide':
				return ['67%', '33%'];
			case 'right-wide':
				return ['33%', '67%'];
			case 'left-narrow':
				return ['33%', '67%'];
			case 'right-narrow':
				return ['67%', '33%'];
			default:
				return ['50%', '50%'];
		}
	}

	if (columnCount === 4) {
		switch (ratio) {
			case 'equal':
				return ['25%', '25%', '25%', '25%'];
			case 'left-wide':
				return ['40%', '20%', '20%', '20%'];
			case 'right-wide':
				return ['20%', '20%', '20%', '40%'];
			case 'left-narrow':
				return ['15%', '28.33%', '28.33%', '28.33%'];
			case 'right-narrow':
				return ['28.33%', '28.33%', '28.33%', '15%'];
			default:
				return ['25%', '25%', '25%', '25%'];
		}
	}

	// 3 columns
	switch (ratio) {
		case 'equal':
			return ['33.33%', '33.33%', '33.33%'];
		case 'left-wide':
			return ['50%', '25%', '25%'];
		case 'right-wide':
			return ['25%', '25%', '50%'];
		case 'left-narrow':
			return ['25%', '37.5%', '37.5%'];
		case 'right-narrow':
			return ['37.5%', '37.5%', '25%'];
		default:
			return ['33.33%', '33.33%', '33.33%'];
	}
};
