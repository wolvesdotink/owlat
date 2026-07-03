import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '@owlat/email-renderer';
import { getSchema } from '../index';
import { createArrayItem } from '../arrayItem';
import type { PropertyField } from '../types';
import type { EditorBlock } from '../../types';

/**
 * Regression: clicking "Add item" on a List (`items: string[]`) or a Table
 * (`headers: string[]`, `rows: string[][]`, `footerRow: string[]`) used to push
 * an OBJECT into a primitive array, which made the renderer call
 * `escapeHtml(object)` / `row.map` on a non-array and throw. Because
 * `renderEmailHtml` maps blocks with no per-block try/catch, that single click
 * blew up the entire render/preview/export. This pins that the value appended
 * by the schema-driven array editor keeps the array's declared primitive shape
 * and that a render round-trip after adding items no longer throws.
 */

function fieldByKey(schemaType: string, key: string): PropertyField {
	const schema = getSchema(schemaType);
	if (!schema) throw new Error(`no schema for ${schemaType}`);
	for (const group of schema.groups) {
		const found = group.fields.find((f) => f.key === key);
		if (found) return found;
	}
	throw new Error(`no field ${key} on ${schemaType}`);
}

describe('array editor "Add item" keeps primitive array shape', () => {
	it('appends a string to string[] fields and a string[] to string[][] fields', () => {
		const itemsField = fieldByKey('list', 'items');
		const headersField = fieldByKey('table', 'headers');
		const rowsField = fieldByKey('table', 'rows');
		const footerField = fieldByKey('table', 'footerRow');

		// List items / table headers / footer are string[] → append a string.
		expect(createArrayItem(itemsField, ['First item'])).toBe('');
		expect(createArrayItem(headersField, ['H1'])).toBe('');
		expect(createArrayItem(footerField, ['F1'])).toBe('');

		// Table rows are string[][] → append a string[] sized to the columns.
		const newRow = createArrayItem(rowsField, [['a', 'b', 'c']]);
		expect(Array.isArray(newRow)).toBe(true);
		expect(newRow).toEqual(['', '', '']);
	});

	it('renders without throwing after adding a List item and a Table row', () => {
		const itemsField = fieldByKey('list', 'items');
		const rowsField = fieldByKey('table', 'rows');
		const headersField = fieldByKey('table', 'headers');

		const listItems = ['First item', 'Second item'];
		listItems.push(createArrayItem(itemsField, listItems) as string);

		const headers = ['Name', 'Value'];
		headers.push(createArrayItem(headersField, headers) as string);

		const rows: string[][] = [['a', 'b']];
		rows.push(createArrayItem(rowsField, rows) as string[]);

		const blocks: EditorBlock[] = [
			{ id: 'list-1', type: 'list', content: { items: listItems, listType: 'bullet' } },
			{ id: 'table-1', type: 'table', content: { headers, rows } },
		];

		let html = '';
		expect(() => {
			html = renderEmailHtml(blocks);
		}).not.toThrow();
		expect(typeof html).toBe('string');
		expect(html).toContain('First item');
	});
});
