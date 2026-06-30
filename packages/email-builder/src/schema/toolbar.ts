import type { BlockAttributeSchema, PropertyField } from './types';

/**
 * Extract fields marked for toolbar display from a schema.
 * Returns fields with `toolbar: true` or listed in `toolbarFields`.
 */
export function getToolbarFields(schema: BlockAttributeSchema): PropertyField[] {
	const toolbarFieldKeys = new Set(schema.toolbarFields ?? []);
	const result: PropertyField[] = [];

	for (const group of schema.groups) {
		for (const field of group.fields) {
			if (field.toolbar || toolbarFieldKeys.has(field.key)) {
				result.push(field);
			}
		}
	}

	return result;
}
