import { describe, expect, it } from 'vitest';
import { TENANT_TABLES } from '../tenantTables';
import { NON_TENANT_TABLES } from '../nonTenantTables';

// The wipe paths walk these lists in order, so a repeated name is wasted work
// and one table in both lists would be wiped and kept at once.
describe('table classification lists', () => {
	const repeats = (list: readonly string[]) => list.filter((name, i) => list.indexOf(name) !== i);

	it('names each tenant table once', () => {
		expect(repeats(TENANT_TABLES)).toEqual([]);
	});
	it('names each non-tenant table once', () => {
		expect(repeats(NON_TENANT_TABLES)).toEqual([]);
	});
	it('never classifies a table both ways', () => {
		const tenant = new Set<string>(TENANT_TABLES);
		expect(NON_TENANT_TABLES.filter((name) => tenant.has(name))).toEqual([]);
	});
});
