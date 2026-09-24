import { describe, it, expect } from 'vitest';
import schema from '../schema';
import {
	CONTACT_RELATIONS,
	DESCENDANT_RELATIONS,
	tablesErasureDeletesFrom,
} from '../contacts/erasure/relations';

/**
 * Schema coverage gate for the contact erasure relation registry
 * (`contacts/erasure/relations.ts`). A new `v.id('contacts')` field, or a new
 * reference to a table the erasure deletes from, fails here until it declares
 * what permanent deletion does to it — so the cascade can never silently fall
 * behind the schema again (clarificationMemory did, and kept learned answers
 * about erased people).
 */

interface ValidatorJson {
	kind: string;
	tableName?: string;
	fields?: Record<string, ValidatorJson>;
	element?: ValidatorJson;
	members?: ValidatorJson[];
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
			collectReferences(validator.value, target, `${path}{}`, out);
			return;
	}
}

/** `table.field` for every schema field holding an id of `target`. */
function schemaReferencesTo(target: string): string[] {
	const refs: string[] = [];
	const tables = (schema as unknown as { tables: Record<string, { validator: ValidatorJson }> })
		.tables;
	for (const [table, definition] of Object.entries(tables)) {
		const fields = new Set<string>();
		collectReferences(definition.validator, target, '', fields);
		for (const field of fields) refs.push(`${table}.${field}`);
	}
	return refs.sort();
}

describe('contact erasure relation registry', () => {
	it('declares a policy for every field in the schema that references contacts', () => {
		const declared = CONTACT_RELATIONS.map((r) => `${r.table}.${r.field}`).sort();
		expect(declared).toEqual(schemaReferencesTo('contacts'));
	});

	it('declares a policy for every reference to a table the erasure deletes from', () => {
		for (const parent of tablesErasureDeletesFrom()) {
			const declared = DESCENDANT_RELATIONS.filter((r) => r.parent === parent)
				.map((r) => `${r.table}.${r.field}`)
				.sort();
			expect(declared, `descendants of ${parent}`).toEqual(schemaReferencesTo(parent));
		}
	});

	it('declares no descendant of a table the erasure never deletes from', () => {
		const parents = tablesErasureDeletesFrom();
		for (const relation of DESCENDANT_RELATIONS) {
			expect(parents.has(relation.parent), `${relation.parent} is not deleted`).toBe(true);
		}
	});

	it('includes the transitive automation step runs', () => {
		expect(
			DESCENDANT_RELATIONS.find(
				(r) => r.parent === 'automationRuns' && r.table === 'automationStepRuns'
			)?.action
		).toBe('delete');
	});

	it('deletes contact-scoped clarification answers instead of unlinking them', () => {
		// An absent contactId is the org-wide scope; unlinking would promote the
		// erased person's answer to every sender.
		expect(CONTACT_RELATIONS.find((r) => r.table === 'clarificationMemory')?.action).toBe('delete');
	});

	it('gives every relation a reason, and only unlink relations a delete condition', () => {
		for (const relation of [...CONTACT_RELATIONS, ...DESCENDANT_RELATIONS]) {
			expect(relation.why.trim().length, `${relation.table}.${relation.field}`).toBeGreaterThan(0);
			if (relation.deletesWhen !== undefined) expect(relation.action).toBe('unlink');
		}
	});
});
