/**
 * The contact-property catalog the **Contact import (module)** resolves row
 * keys against, and its integration-driven auto-registration (ADR-0019).
 *
 * A property being deleted (#918) is not in `byKey`: its key is listed in
 * `pendingDeletion` instead, so an import neither writes values into the
 * column its cleanup job is draining nor registers a second property under the
 * same key while the first still exists.
 */

import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

export interface PropertyCatalog {
	byKey: Map<string, Id<'contactProperties'>>;
	pendingDeletion: Set<string>;
}

type PropertyType = 'string' | 'number' | 'boolean' | 'date';

function inferPropertyType(value: string | number | boolean): PropertyType {
	if (typeof value === 'number') return 'number';
	if (typeof value === 'boolean') return 'boolean';
	return 'string';
}

export async function loadPropertyCatalog(ctx: MutationCtx): Promise<PropertyCatalog> {
	const rows = await ctx.db.query('contactProperties').collect(); // bounded: custom property definitions (org-scale, few)
	const byKey = new Map<string, Id<'contactProperties'>>();
	const pendingDeletion = new Set<string>();
	for (const row of rows) {
		if (row.deletionRequestedAt === undefined) byKey.set(row.key, row._id);
		else pendingDeletion.add(row.key);
	}
	return { byKey, pendingDeletion };
}

/** Register `key` as a new auto-registered property (integration sources only). */
export async function autoRegisterProperty(
	ctx: MutationCtx,
	catalog: PropertyCatalog,
	key: string,
	value: string | number | boolean,
	source: string
): Promise<Id<'contactProperties'>> {
	const propertyId = await ctx.db.insert('contactProperties', {
		key,
		label: key,
		type: inferPropertyType(value),
		autoRegistered: true,
		autoRegisteredSource: source,
		createdAt: Date.now(),
	});
	catalog.byKey.set(key, propertyId);
	return propertyId;
}
