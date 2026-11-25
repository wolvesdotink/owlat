/**
 * The batches an auto-translate run sends: `translateBatch` refuses more than
 * 50 items or 100,000 characters in one call, and a long table has more rows
 * than that.
 */
const TRANSLATE_BATCH_ITEMS = 50;
const TRANSLATE_BATCH_CHARS = 100_000;

/** `items` in order, split into batches the action accepts. */
export function translateBatches<T extends { text: string }>(items: readonly T[]): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	let chars = 0;
	for (const item of items) {
		if (
			current.length > 0 &&
			(current.length >= TRANSLATE_BATCH_ITEMS || chars + item.text.length > TRANSLATE_BATCH_CHARS)
		) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(item);
		chars += item.text.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}
