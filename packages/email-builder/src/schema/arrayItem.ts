import type { PropertyField } from './types';

/**
 * Produce the value appended to an `array` field when the user clicks
 * "Add item" in the property panel.
 *
 * The block content types are the source of truth: `list.items` and
 * `table.headers`/`footerRow` are `string[]`, `table.rows` is `string[][]`.
 * Pushing an OBJECT into one of those arrays makes the renderer call
 * `escapeHtml(object)` (or `row.map` on a non-array) and throw, which — since
 * `renderEmailHtml` maps blocks with no per-block try/catch — takes down the
 * entire render/preview/export on a single click. This helper keeps the
 * appended value shape-compatible with the field's declared `itemType`.
 *
 * `itemSchema`/`itemDefault` remain the path for genuine OBJECT arrays (e.g.
 * social links).
 */
export function createArrayItem(field: PropertyField, currentItems: readonly unknown[]): unknown {
	// Primitive string array (e.g. list items, table headers, footer).
	if (field.itemType === 'string') return '';

	// Matrix: array of string rows (e.g. table rows). Match the width of the
	// existing rows so a new row lines up with the current columns.
	if (field.itemType === 'string[]') {
		const first = currentItems[0];
		const width = Array.isArray(first) && first.length > 0 ? first.length : 1;
		return Array.from({ length: width }, () => '');
	}

	// Object array with an explicit factory.
	if (field.itemDefault) return field.itemDefault();

	// Legacy fallback for arrays declared without `itemType`: infer from the
	// current contents so a string array still gets a string.
	if (currentItems.length > 0 && typeof currentItems[0] === 'string') return '';
	return {};
}
