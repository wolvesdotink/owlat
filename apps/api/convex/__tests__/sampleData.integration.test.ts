/**
 * Sample data on a REAL install: `POST /sample-data/{install,remove,status}`.
 *
 * The properties that make this path safe to ship to a self-hoster:
 *   - it works with `OWLAT_DEV_MODE` unset, while `/seed/demo` stays 403 —
 *     nobody has to unlock the dev endpoints to get demo content;
 *   - it creates NO sign-ins (the dummy teammate accounts carry published
 *     password hashes and stay on the dev-only path);
 *   - removal deletes exactly the seeded rows and leaves the operator's own
 *     data alone, however similar it looks;
 *   - both directions are idempotent, so a re-run is never destructive.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';

const modules = import.meta.glob('../**/*.*s');

const SECRET = 'sample-data-test-secret-at-least-32-characters';

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	// The whole point of this path: no dev mode anywhere near it.
	vi.stubEnv('OWLAT_DEV_MODE', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

type TestConvex = ReturnType<typeof convexTest>;

function post(t: TestConvex, path: string, secret: string | null): Promise<Response> {
	return t.fetch(path, {
		method: 'POST',
		headers: secret === null ? {} : { 'X-Instance-Secret': secret },
	});
}

async function install(t: TestConvex): Promise<Record<string, Record<string, number>>> {
	const res = await post(t, '/sample-data/install', SECRET);
	if (res.status !== 200) throw new Error(`install ${res.status}: ${await res.text()}`);
	return (await res.json()) as Record<string, Record<string, number>>;
}

describe('sample data — authentication', () => {
	it('refuses every endpoint without the instance secret', async () => {
		const t = convexTest(schema, modules);
		for (const path of ['/sample-data/install', '/sample-data/remove', '/sample-data/status']) {
			expect((await post(t, path, null)).status).toBe(401);
			expect((await post(t, path, 'wrong-secret')).status).toBe(401);
		}
		const contacts = await t.run(async (ctx) => await ctx.db.query('contacts').collect());
		expect(contacts).toHaveLength(0);
	});

	it('leaves the dev-only seed endpoint fail-closed', async () => {
		const t = convexTest(schema, modules);
		const res = await post(t, '/seed/demo', SECRET);
		expect(res.status).toBe(403);
	});
});

describe('sample data — install', () => {
	it('populates the instance without dev mode and without creating sign-ins', async () => {
		const t = convexTest(schema, modules);
		const summary = await install(t);

		expect(summary['inserted']?.['contacts']).toBe(15);
		expect(summary['inserted']?.['topics']).toBe(3);
		expect(summary['inserted']?.['emailTemplates']).toBeGreaterThan(0);
		expect(summary['inserted']?.['campaigns']).toBeGreaterThan(0);
		expect(summary['inserted']?.['automations']).toBeGreaterThan(0);
		expect(summary['inserted']?.['domains']).toBe(1);

		// The loaders that would put unowned credentials/mailboxes on a real
		// install are not part of the sample-data selection at all.
		expect(summary['inserted']).not.toHaveProperty('accounts');
		expect(summary['inserted']).not.toHaveProperty('mailboxes');

		const state = await t.run(async (ctx) => ({
			profiles: await ctx.db.query('userProfiles').collect(),
			mailboxMembers: await ctx.db.query('mailboxMembers').collect(),
			sends: await ctx.db.query('emailSends').collect(),
		}));
		expect(state.profiles).toHaveLength(0);
		expect(state.mailboxMembers).toHaveLength(0);
		// A sent campaign with real per-recipient stats is the point of the dataset.
		expect(state.sends.length).toBeGreaterThan(0);
	});

	it('is idempotent — a second install inserts nothing new', async () => {
		const t = convexTest(schema, modules);
		await install(t);
		const second = await install(t);

		expect(second['inserted']?.['contacts']).toBe(0);
		expect(second['skipped']?.['contacts']).toBe(15);

		const contacts = await t.run(async (ctx) => await ctx.db.query('contacts').collect());
		expect(contacts).toHaveLength(15);
	});

	it('tags every row it writes so removal can find them again', async () => {
		const t = convexTest(schema, modules);
		await install(t);
		const untagged = await t.run(async (ctx) => {
			const rows = [
				...(await ctx.db.query('contacts').collect()),
				...(await ctx.db.query('topics').collect()),
				...(await ctx.db.query('campaigns').collect()),
				...(await ctx.db.query('automations').collect()),
				...(await ctx.db.query('domains').collect()),
			];
			return rows.filter((row) => (row as { seedTag?: string }).seedTag !== 'demo');
		});
		expect(untagged).toEqual([]);
	});
});

describe('sample data — status and removal', () => {
	it('reports what is present, then removes exactly that', async () => {
		const t = convexTest(schema, modules);
		await install(t);

		const statusRes = await post(t, '/sample-data/status', SECRET);
		expect(statusRes.status).toBe(200);
		const status = (await statusRes.json()) as {
			present: Record<string, number>;
			total: number;
		};
		expect(status.present['contacts']).toBe(15);
		expect(status.total).toBeGreaterThan(15);

		const removeRes = await post(t, '/sample-data/remove', SECRET);
		expect(removeRes.status).toBe(200);
		const removed = (await removeRes.json()) as { deleted: Record<string, number> };
		expect(removed.deleted['contacts']).toBe(15);
		expect(removed.deleted['topics']).toBe(3);

		const after = await t.run(async (ctx) => ({
			contacts: await ctx.db.query('contacts').collect(),
			topics: await ctx.db.query('topics').collect(),
			campaigns: await ctx.db.query('campaigns').collect(),
			sends: await ctx.db.query('emailSends').collect(),
			domains: await ctx.db.query('domains').collect(),
			automations: await ctx.db.query('automations').collect(),
		}));
		for (const rows of Object.values(after)) expect(rows).toHaveLength(0);

		const emptyStatus = (await (await post(t, '/sample-data/status', SECRET)).json()) as {
			total: number;
		};
		expect(emptyStatus.total).toBe(0);
	});

	it('never touches rows the operator created', async () => {
		const t = convexTest(schema, modules);
		await install(t);

		const mine = await t.run(async (ctx) => {
			const now = Date.now();
			const contactId = await ctx.db.insert('contacts', {
				email: 'real.customer@example.com',
				source: 'api',
				doiStatus: 'confirmed',
				searchableText: 'real.customer@example.com',
				createdAt: now,
				updatedAt: now,
			});
			const topicId = await ctx.db.insert('topics', {
				name: 'Real topic',
				createdAt: now,
				updatedAt: now,
			});
			return { contactId, topicId };
		});

		await post(t, '/sample-data/remove', SECRET);

		const survivors = await t.run(async (ctx) => ({
			contact: await ctx.db.get(mine.contactId),
			topic: await ctx.db.get(mine.topicId),
			contacts: await ctx.db.query('contacts').collect(),
		}));
		expect(survivors.contact).not.toBeNull();
		expect(survivors.topic).not.toBeNull();
		expect(survivors.contacts).toHaveLength(1);
	});

	it('is a no-op on an instance that never installed sample data', async () => {
		const t = convexTest(schema, modules);
		const res = await post(t, '/sample-data/remove', SECRET);
		expect(res.status).toBe(200);
		expect((await res.json()) as { deleted: Record<string, number> }).toEqual({ deleted: {} });
	});
});
