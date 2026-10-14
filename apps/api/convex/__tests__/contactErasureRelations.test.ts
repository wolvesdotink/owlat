import { describe, it, expect } from 'vitest';
import {
	CONTACT_RELATIONS,
	DESCENDANT_RELATIONS,
	tablesErasureDeletesFrom,
} from '../contacts/erasure/relations';
import { schemaReferencesTo, schemaStringContactReferences } from './schemaReferences';

/**
 * Schema coverage gate for the contact erasure relation registry
 * (`contacts/erasure/relations.ts`). A new `v.id('contacts')` field, a new
 * plain-string field the walk recognises as a contact id, or a new
 * reference to a table the erasure deletes from, fails here until it declares
 * what permanent deletion does to it — so the cascade can never silently fall
 * behind the schema again (clarificationMemory did, and kept learned answers
 * about erased people).
 */

describe('contact erasure relation registry', () => {
	it('declares a policy for every field in the schema that references contacts', () => {
		const declared = CONTACT_RELATIONS.map((r) => `${r.table}.${r.field}`).sort();
		const inSchema = [
			...schemaReferencesTo('contacts'),
			...schemaStringContactReferences().map((r) => r.ref),
		].sort();
		expect(declared).toEqual(inSchema);
	});

	it('names the discriminator of every contact id held in a plain string', () => {
		const discriminators = new Map(
			schemaStringContactReferences().map((r) => [r.ref, r.discriminator])
		);
		for (const relation of CONTACT_RELATIONS) {
			const ref = `${relation.table}.${relation.field}`;
			if (!discriminators.has(ref)) {
				expect(relation.when, `${ref} is a v.id field`).toBeUndefined();
				continue;
			}
			const discriminator = discriminators.get(ref);
			// A string named for the contact itself needs no discriminator.
			if (discriminator === undefined) continue;
			expect(relation.when, ref).toEqual({ field: discriminator, equals: 'contact' });
		}
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
