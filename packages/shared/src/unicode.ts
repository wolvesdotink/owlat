/** Truncate by Unicode code points without allocating an array for the whole input. */
export function truncateCodePoints(value: string, limit: number): string {
	let count = 0;
	let codeUnitEnd = 0;
	for (const codePoint of value) {
		if (count >= limit) return value.slice(0, codeUnitEnd);
		count += 1;
		codeUnitEnd += codePoint.length;
	}
	return value;
}
