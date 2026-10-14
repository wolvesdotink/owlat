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

/**
 * A plain `v.string()` field the walk recognises as holding an id of `kind`,
 * which `v.id` typing would have made visible to `referencesTo`. Two shapes:
 *
 *   - a discriminated id: `<x>Id` next to a sibling `<x>`, `<x>Type` or
 *     `<x>Kind` field whose literals include `kind` (`scopeType: 'contact'` +
 *     `scopeId`, `resource: 'contact'` + `resourceId`). The pairing by name is
 *     what keeps unrelated strings out: `organizationId` beside `scopeType` is
 *     not claimed, because no `organization`/`organizationType` field says so;
 *   - a string named for the kind itself: `contactId`, `fromContactId`,
 *     `contactIds` (as `[]`), which should have been `v.id` in the first place.
 */
export interface StringReference {
	/** `table.field` */
	ref: string;
	/** The sibling field naming the id's kind; absent for a name-only match. */
	discriminator?: string;
}

function isStringField(validator: ValidatorJson | undefined): boolean {
	if (!validator) return false;
	if (validator.kind === 'string') return true;
	if (validator.kind === 'union') return (validator.members ?? []).some(isStringField);
	return false;
}

function namesLiteral(validator: ValidatorJson | undefined, kind: string): boolean {
	if (!validator) return false;
	if (validator.kind === 'literal') return (validator as { value?: unknown }).value === kind;
	if (validator.kind === 'union')
		return (validator.members ?? []).some((member) => namesLiteral(member, kind));
	return false;
}

function collectStringReferences(
	validator: ValidatorJson | undefined,
	kind: string,
	path: string,
	out: StringReference[]
): void {
	if (!validator) return;
	if (validator.kind === 'union') {
		for (const member of validator.members ?? []) collectStringReferences(member, kind, path, out);
		return;
	}
	if (validator.kind === 'array') {
		collectStringReferences(validator.element, kind, `${path}[]`, out);
		return;
	}
	if (validator.kind === 'record') {
		collectStringReferences(validator.value, kind, `${path}{}`, out);
		return;
	}
	if (validator.kind !== 'object') return;
	const fields = validator.fields ?? {};
	const capitalised = kind.charAt(0).toUpperCase() + kind.slice(1);
	const named = new RegExp(`(^${kind}|${capitalised})Ids?$`);
	for (const [name, field] of Object.entries(fields)) {
		const fieldPath = path ? `${path}.${name}` : name;
		const element = field.kind === 'array' ? field.element : field;
		if (isStringField(element)) {
			const ref = field.kind === 'array' ? `${fieldPath}[]` : fieldPath;
			const prefix = name.endsWith('Id') ? name.slice(0, -2) : undefined;
			const discriminator = prefix
				? [prefix, `${prefix}Type`, `${prefix}Kind`].find((sibling) =>
						namesLiteral(fields[sibling], kind)
					)
				: undefined;
			if (discriminator) out.push({ ref, discriminator });
			else if (named.test(name)) out.push({ ref });
		}
		collectStringReferences(field, kind, fieldPath, out);
	}
}

/** Every plain-string field of `tables` recognised as an id of `kind`, sorted. */
export function stringReferencesTo(
	tables: Record<string, { validator: unknown }>,
	kind: string
): StringReference[] {
	const refs: StringReference[] = [];
	for (const [table, definition] of Object.entries(tables)) {
		const found: StringReference[] = [];
		collectStringReferences(definition.validator as ValidatorJson, kind, '', found);
		for (const reference of found) refs.push({ ...reference, ref: `${table}.${reference.ref}` });
	}
	return refs.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** The schema's plain-string fields recognised as contact ids. */
export function schemaStringContactReferences(): StringReference[] {
	return stringReferencesTo(
		(schema as unknown as { tables: Record<string, { validator: unknown }> }).tables,
		'contact'
	);
}
