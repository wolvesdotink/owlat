import schema from '../schema';

/**
 * The schema walk behind the relation coverage gates: every field, at any
 * depth, that holds an id of a given table. Shared by the erasure registry test
 * (`contactErasureRelations.test.ts`) and the merge one
 * (`contactMergeRelations.test.ts`) so both read the schema the same way.
 */

interface ValidatorJson {
	kind: string;
	tableName?: string;
	fields?: Record<string, ValidatorJson>;
	element?: ValidatorJson;
	members?: ValidatorJson[];
	key?: ValidatorJson;
	value?: ValidatorJson;
}

function collectReferences(
	validator: ValidatorJson | undefined,
	target: string,
	path: string,
	out: Set<string>
): void {
	if (!validator) return;
	switch (validator.kind) {
		case 'id':
			if (validator.tableName === target) out.add(path);
			return;
		case 'object':
			for (const [key, field] of Object.entries(validator.fields ?? {})) {
				collectReferences(field, target, path ? `${path}.${key}` : key, out);
			}
			return;
		case 'array':
			collectReferences(validator.element, target, `${path}[]`, out);
			return;
		case 'union':
			for (const member of validator.members ?? []) collectReferences(member, target, path, out);
			return;
		case 'record':
			// A key can be an id too: `v.record(v.id('contacts'), …)`.
			collectReferences(validator.key, target, `${path}{key}`, out);
			collectReferences(validator.value, target, `${path}{}`, out);
			return;
	}
}

/** `table.field` for every field of `tables` holding an id of `target`, sorted. */
export function referencesTo(
	tables: Record<string, { validator: unknown }>,
	target: string
): string[] {
	const refs: string[] = [];
	for (const [table, definition] of Object.entries(tables)) {
		const fields = new Set<string>();
		collectReferences(definition.validator as ValidatorJson, target, '', fields);
		for (const field of fields) refs.push(`${table}.${field}`);
	}
	return refs.sort();
}

/** `table.field` for every schema field holding an id of `target`, sorted. */
export function schemaReferencesTo(target: string): string[] {
	return referencesTo(
		(schema as unknown as { tables: Record<string, { validator: unknown }> }).tables,
		target
	);
}
