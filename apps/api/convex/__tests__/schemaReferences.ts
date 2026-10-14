import schema from '../schema';
import {
	DECLARED_CONTACT_STRING_REFERENCES,
	NOT_CONTACT_STRING_REFERENCES,
} from '../lib/contactStringReferences';

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
 * A plain-string field the walk recognises as holding an id of `kind`, which
 * `v.id` typing would have made visible to `referencesTo`. Two shapes:
 *
 *   - a discriminated id: `<x>Id` or `<x>Ids` next to a sibling `<x>`,
 *     `<x>Type` or `<x>Kind` field whose literals include `kind`
 *     (`scopeType: 'contact'` + `scopeId`, `resource: 'contact'` +
 *     `resourceId`). Pairing by name is what keeps unrelated strings out:
 *     `organizationId` beside `scopeType` is not claimed, because no
 *     `organization`/`organizationType` field says it is a contact;
 *   - a string named for the kind itself: `contactId`, `fromContactId`,
 *     `contactIds`, which should have been `v.id` in the first place.
 *
 * The field's name and its siblings decide; its container does not. A string
 * reached through a union, an optional, an array (of any depth) or a record
 * value counts, with the path saying where (`contactIds[]`, `matrix[][]`,
 * `byContact{}`). What no name can reveal (an arbitrarily named string, a
 * plain-string record key) is declared by hand in
 * `lib/contactStringReferences.ts`.
 */
export interface StringReference {
	/** `table.field` */
	ref: string;
	/** The sibling field naming the id's kind; absent for a name-only match. */
	discriminator?: string;
}

function namesLiteral(validator: ValidatorJson | undefined, kind: string): boolean {
	if (!validator) return false;
	if (validator.kind === 'literal') return (validator as { value?: unknown }).value === kind;
	if (validator.kind === 'union')
		return (validator.members ?? []).some((member) => namesLiteral(member, kind));
	return false;
}

/**
 * The path suffixes at which `validator` holds a plain string, looking through
 * unions, arrays and record values but not into objects (an object's own
 * fields are judged by their own names).
 */
function stringSuffixes(
	validator: ValidatorJson | undefined,
	suffix: string,
	out: Set<string>
): void {
	if (!validator) return;
	switch (validator.kind) {
		case 'string':
			out.add(suffix);
			return;
		case 'union':
			for (const member of validator.members ?? []) stringSuffixes(member, suffix, out);
			return;
		case 'array':
			stringSuffixes(validator.element, `${suffix}[]`, out);
			return;
		case 'record':
			stringSuffixes(validator.value, `${suffix}{}`, out);
			return;
	}
}

/** Every object reachable from `validator` without passing through another object's field. */
function objectsIn(
	validator: ValidatorJson | undefined,
	path: string,
	visit: (object: ValidatorJson, path: string) => void
): void {
	if (!validator) return;
	switch (validator.kind) {
		case 'object':
			visit(validator, path);
			return;
		case 'union':
			for (const member of validator.members ?? []) objectsIn(member, path, visit);
			return;
		case 'array':
			objectsIn(validator.element, `${path}[]`, visit);
			return;
		case 'record':
			objectsIn(validator.value, `${path}{}`, visit);
			return;
	}
}

function collectStringReferences(
	object: ValidatorJson,
	kind: string,
	path: string,
	out: Map<string, StringReference>
): void {
	const fields = object.fields ?? {};
	const capitalised = kind.charAt(0).toUpperCase() + kind.slice(1);
	const named = new RegExp(`(^${kind}|${capitalised})Ids?$`);
	for (const [name, field] of Object.entries(fields)) {
		const fieldPath = path ? `${path}.${name}` : name;
		const prefix = /Ids?$/.test(name) ? name.replace(/Ids?$/, '') : undefined;
		const discriminator = prefix
			? [prefix, `${prefix}Type`, `${prefix}Kind`].find((sibling) =>
					namesLiteral(fields[sibling], kind)
				)
			: undefined;
		if (discriminator || named.test(name)) {
			const suffixes = new Set<string>();
			stringSuffixes(field, '', suffixes);
			for (const suffix of suffixes) {
				const ref = `${fieldPath}${suffix}`;
				out.set(ref, discriminator ? { ref, discriminator } : { ref });
			}
		}
		objectsIn(field, fieldPath, (nested, nestedPath) =>
			collectStringReferences(nested, kind, nestedPath, out)
		);
	}
}

/** Every plain-string field of `tables` recognised as an id of `kind`, sorted. */
export function stringReferencesTo(
	tables: Record<string, { validator: unknown }>,
	kind: string
): StringReference[] {
	const refs: StringReference[] = [];
	for (const [table, definition] of Object.entries(tables)) {
		const found = new Map<string, StringReference>();
		objectsIn(definition.validator as ValidatorJson, '', (object, path) =>
			collectStringReferences(object, kind, path, found)
		);
		for (const reference of found.values()) {
			refs.push({ ...reference, ref: `${table}.${reference.ref}` });
		}
	}
	return refs.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** `table.field` for every place in `tables` that holds a plain string, sorted. */
export function stringFieldsIn(tables: Record<string, { validator: unknown }>): string[] {
	const refs = new Set<string>();
	const visitObject = (table: string) => (object: ValidatorJson, path: string) => {
		for (const [name, field] of Object.entries(object.fields ?? {})) {
			const fieldPath = path ? `${path}.${name}` : name;
			const suffixes = new Set<string>();
			stringSuffixes(field, '', suffixes);
			for (const suffix of suffixes) refs.add(`${table}.${fieldPath}${suffix}`);
			stringRecordKeys(field, fieldPath, table, refs);
			objectsIn(field, fieldPath, visitObject(table));
		}
	};
	for (const [table, definition] of Object.entries(tables)) {
		objectsIn(definition.validator as ValidatorJson, '', visitObject(table));
	}
	return [...refs].sort();
}

/** Record `field{key}` for every plain-string record key under `validator`. */
function stringRecordKeys(
	validator: ValidatorJson | undefined,
	path: string,
	table: string,
	out: Set<string>
): void {
	if (!validator) return;
	switch (validator.kind) {
		case 'union':
			for (const member of validator.members ?? []) stringRecordKeys(member, path, table, out);
			return;
		case 'array':
			stringRecordKeys(validator.element, `${path}[]`, table, out);
			return;
		case 'record':
			if (validator.key?.kind === 'string') out.add(`${table}.${path}{key}`);
			stringRecordKeys(validator.value, `${path}{}`, table, out);
			return;
	}
}

const schemaTables = (): Record<string, { validator: unknown }> =>
	(schema as unknown as { tables: Record<string, { validator: unknown }> }).tables;

/** The schema's plain-string fields recognised as contact ids. */
export function schemaStringContactReferences(): StringReference[] {
	return stringReferencesTo(schemaTables(), 'contact');
}

/** Every place in the schema that holds a plain string. */
export function schemaStringFields(): string[] {
	return stringFieldsIn(schemaTables());
}

/**
 * Every place in `tables` that holds a contact id, as `table.field`, sorted
 * and once each: the `v.id('contacts')` fields, the plain strings the name
 * rule recognises (minus `notContact`), and the hand-declared ones. A field
 * typed `v.union(v.id('contacts'), v.string())` is found by both walks and
 * counted once.
 */
export function contactReferencesIn(
	tables: Record<string, { validator: unknown }>,
	declared: Readonly<Record<string, string>>,
	notContact: Readonly<Record<string, string>>
): string[] {
	const refs = new Set(referencesTo(tables, 'contacts'));
	for (const { ref } of stringReferencesTo(tables, 'contact')) {
		if (!(ref in notContact)) refs.add(ref);
	}
	for (const ref of Object.keys(declared)) refs.add(ref);
	return [...refs].sort();
}

/** Every place in the schema that holds a contact id; what both coverage gates check. */
export function schemaContactReferences(): string[] {
	return contactReferencesIn(
		schemaTables(),
		DECLARED_CONTACT_STRING_REFERENCES,
		NOT_CONTACT_STRING_REFERENCES
	);
}
