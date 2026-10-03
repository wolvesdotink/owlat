/**
 * Drift guard between the per-literal contact-activity modules and the table.
 *
 * Every module under `contactActivities/<literal>/index.ts` declares the
 * metadata its writers may pass (`metadataSchema`), but the `contactActivities`
 * table stores all of them through one shared validator. A field a module
 * allows and the table does not makes every insert carrying it throw, which
 * rolls back whatever mutation wrote the activity (issue #1184: `automationId`
 * kept automation sends `queued` and dropped their bounces and complaints).
 *
 * The modules are read from `ACTIVITY_MODULES`, the writer's dispatch table,
 * which is compile-time tied to the activity catalog, so a new literal is
 * covered without touching this file. The table side is read from the schema
 * itself rather than from the exported validator, so the check follows
 * whatever the table really stores.
 */

import { describe, expect, it } from 'vitest';
import type { GenericValidator } from 'convex/values';
import schema from '../../schema';
import { ACTIVITY_MODULES } from '../writer';

type ObjectValidator = GenericValidator & {
	kind: 'object';
	fields: Record<string, GenericValidator>;
};

function objectFields(
	validator: GenericValidator,
	label: string
): Record<string, GenericValidator> {
	if (validator.kind !== 'object') {
		throw new Error(`${label} is a ${validator.kind} validator, expected an object`);
	}
	return (validator as ObjectValidator).fields;
}

const tableFields = objectFields(
	schema.tables.contactActivities.validator.fields.metadata,
	'contactActivities.metadata'
);

const moduleFields = Object.values(ACTIVITY_MODULES).flatMap((module) =>
	Object.entries(objectFields(module.metadataSchema, `${module.literal} metadataSchema`)).map(
		([field, validator]) => ({ literal: module.literal, field, validator })
	)
);

describe('contact-activity metadata: modules vs table validator', () => {
	it('reads at least one field from every module', () => {
		const literals = new Set(moduleFields.map((entry) => entry.literal));
		expect([...literals].sort()).toEqual(Object.keys(ACTIVITY_MODULES).sort());
	});

	it('the table validator accepts every field a module schema declares', () => {
		const missing = moduleFields
			.filter(({ field }) => !(field in tableFields))
			.map(({ literal, field }) => `${literal}.${field}`);
		expect(missing).toEqual([]);
	});

	it('each shared field has the same value kind in the module and the table', () => {
		const mismatched = moduleFields
			.filter(({ field }) => field in tableFields)
			.filter(({ field, validator }) => tableFields[field]!.kind !== validator.kind)
			.map(
				({ literal, field, validator }) =>
					`${literal}.${field}: module ${validator.kind}, table ${tableFields[field]!.kind}`
			);
		expect(mismatched).toEqual([]);
	});

	it('every table field is optional, because each literal writes only its own subset', () => {
		const required = Object.entries(tableFields)
			.filter(([, validator]) => validator.isOptional !== 'optional')
			.map(([field]) => field);
		expect(required).toEqual([]);
	});
});
