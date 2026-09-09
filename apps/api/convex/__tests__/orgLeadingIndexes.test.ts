/**
 * Tenant-scoped analytics tables declare every caller-reachable index
 * org-leading, so a cell or send-id lookup can never page across tenants; the
 * one exemption per table is the deployment-wide retention sweep, which is
 * reachable only from an internal cron and must not enumerate organizations to
 * find old rows. Read off the schema object, and EXHAUSTIVE on purpose: an
 * index nobody reads on a per-recipient or per-response table is the write
 * amplification D16 exists to bound.
 */
import { describe, expect, it } from 'vitest';
import schema from '../schema';

const TABLES: ReadonlyArray<{
	readonly table: keyof typeof schema.tables;
	readonly indexes: Readonly<Record<string, readonly string[]>>;
}> = [
	{
		table: 'sendAssignments',
		indexes: {
			by_org_send: ['organizationId', 'sendId'],
			by_assigned_at: ['assignedAt'],
		},
	},
	{
		table: 'smtpResponseCategories',
		indexes: {
			by_org_cell_arm_period_shard: ['organizationId', 'cell', 'arm', 'periodStart', 'shardKey'],
			by_period_start: ['periodStart'],
		},
	},
];

function declaredIndexes(table: keyof typeof schema.tables): Record<string, string[]> {
	const definition = schema.tables[table] as unknown as {
		' indexes'(): { indexDescriptor: string; fields: string[] }[];
	};
	return Object.fromEntries(
		definition[' indexes']().map((index) => [index.indexDescriptor, index.fields])
	);
}

describe.each(TABLES)('$table indexes', ({ table, indexes }) => {
	it('declares exactly the expected indexes', () => {
		expect(declaredIndexes(table)).toEqual(indexes);
	});

	it('leads every index with organizationId except the retention sweep', () => {
		for (const [name, fields] of Object.entries(declaredIndexes(table))) {
			if (fields.length === 1 && /At$|Start$/.test(fields[0] ?? '')) continue;
			expect(fields[0], `${table}.${name}`).toBe('organizationId');
		}
	});
});
