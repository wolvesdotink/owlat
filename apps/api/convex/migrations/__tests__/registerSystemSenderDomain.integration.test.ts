/**
 * Migration 0075 gives an existing install the system sender's domain as a
 * sending domain once, so the MTA has a key to sign account mail with, and
 * leaves the domain alone after that.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';

const MIGRATION = '0075_register_system_sender_domain';
const migration = internal.migrations[MIGRATION];

type Harness = TestConvex<typeof schema>;

function domains(t: Harness) {
	return t.run((ctx) => ctx.db.query('domains').collect());
}

function ledger(t: Harness) {
	return t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
			.unique()
	);
}

beforeEach(() => {
	vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.org');
	vi.stubEnv('MTA_INTERNAL_URL', 'http://mta.internal:3100');
	vi.stubEnv('MTA_API_KEY', 'mta-key');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('0075_register_system_sender_domain', () => {
	it('registers the system sender domain with the built-in MTA once', async () => {
		const t = convexTest(schema, modules);

		expect(await t.mutation(migration.run, {})).toEqual({ started: true });
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
		expect(await t.mutation(migration.ensure, {})).toEqual({ started: false });

		expect(await domains(t)).toEqual([
			expect.objectContaining({ domain: 'mail.example.org', providerType: 'mta' }),
		]);
		expect(await ledger(t)).toMatchObject({ status: 'completed', changedCount: 1 });
	});

	it('creates nothing when the operator already added the domain', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'mail.example.org',
				status: 'verified',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: 1,
				updatedAt: 1,
			});
		});

		expect(await t.mutation(migration.run, {})).toEqual({ started: true });
		expect(await domains(t)).toHaveLength(1);
		expect(await ledger(t)).toMatchObject({ status: 'completed', changedCount: 0 });
	});

	it('waits for a system sender, then registers it', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		const t = convexTest(schema, modules);

		expect(await t.mutation(migration.ensure, {})).toMatchObject({ started: false });
		expect(await ledger(t)).toBeNull();

		vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.org');
		expect(await t.mutation(migration.ensure, {})).toEqual({ started: true });
		expect(await domains(t)).toHaveLength(1);
	});

	it('waits while mail goes through a relay', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'ses');
		const t = convexTest(schema, modules);

		expect(await t.mutation(migration.ensure, {})).toMatchObject({ started: false });
		expect(await domains(t)).toEqual([]);
	});

	it('completes without a domain when the runner starts it before a sender is configured', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
		const t = convexTest(schema, modules);

		expect(await t.mutation(migration.run, {})).toEqual({ started: true });
		expect(await domains(t)).toEqual([]);
		expect(await ledger(t)).toMatchObject({ status: 'completed', changedCount: 0 });
	});

	it('does not add the domain back after the operator removed it', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(migration.run, {});
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('domains').collect()) await ctx.db.delete(row._id);
		});

		expect(await t.mutation(migration.ensure, {})).toEqual({ started: false });
		expect(await domains(t)).toEqual([]);
	});
});
