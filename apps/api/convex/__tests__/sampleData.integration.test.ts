/**
 * Sample data on a REAL install: `POST /sample-data/{install,remove,status}`.
 *
 * The properties that make this path safe to ship to a self-hoster:
 *   - it works with `OWLAT_DEV_MODE` unset, while `/seed/demo` stays 403 —
 *     nobody has to unlock the dev endpoints to get demo content;
 *   - it creates NO sign-ins (the dummy teammate accounts carry published
 *     password hashes and stay on the dev-only path);
 *   - nothing it writes can ACT: the sample automation is paused and the sample
 *     webhook disabled, so the operator's own contacts are never mailed or
 *     exfiltrated by demo scenery;
 *   - removal deletes exactly the seeded rows and leaves the operator's own
 *     data alone, however similar it looks;
 *   - both directions are idempotent, so a re-run is never destructive.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { applyLoaders } from '../seedDemo/pipeline';

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

	it('leaves the compliance telemetry fixtures on the dev-only path', async () => {
		const t = convexTest(schema, modules);
		const summary = await install(t);

		// Gmail bulk-sender rollups for demo.example read as a real domain just
		// under the threshold in the compliance view — dev scenery only.
		expect(summary['inserted']).not.toHaveProperty('complianceTelemetry');
		const rollups = await t.run(
			async (ctx) => await ctx.db.query('gmailDomainVolumeRollups').collect()
		);
		expect(rollups).toHaveLength(0);
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

describe('sample data — inert on a real instance', () => {
	it('installs the automation paused, so a real signup is never mailed', async () => {
		const t = convexTest(schema, modules);
		await install(t);

		const automations = await t.run(async (ctx) => await ctx.db.query('automations').collect());
		expect(automations.length).toBeGreaterThan(0);
		expect(automations.filter((a) => a.status === 'active')).toEqual([]);
		// No activation timestamp either — a paused row that claims it was
		// activated is a lie the automations UI would repeat.
		expect(automations.filter((a) => a.activatedAt !== undefined)).toEqual([]);

		// The fixture automation triggers on contact_created and sends the
		// "Summer sale" template. The next genuine signup must get nothing.
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert('contacts', {
					email: 'genuine.signup@customer.example',
					source: 'form' as const,
					doiStatus: 'confirmed' as const,
					searchableText: 'genuine.signup@customer.example',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})
		);
		await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, { contactId });

		const runs = await t.run(async (ctx) => await ctx.db.query('automationRuns').collect());
		expect(runs).toEqual([]);
	});

	it('keeps the dev seed live — inert is the sample-data caller, not the loaders', async () => {
		const t = convexTest(schema, modules);
		// What `/seed/demo` runs: no options, so the throwaway dev instance still
		// gets the live automation and webhook it has always had.
		await t.run(async (ctx) => {
			await applyLoaders(ctx, ['emailTemplates', 'automations', 'webhooks']);
		});

		const state = await t.run(async (ctx) => ({
			automations: await ctx.db.query('automations').collect(),
			webhooks: await ctx.db.query('webhooks').collect(),
		}));
		expect(state.automations.filter((a) => a.status === 'active').length).toBeGreaterThan(0);
		expect(
			state.automations.every((a) => a.status !== 'active' || a.activatedAt !== undefined)
		).toBe(true);
		expect(state.webhooks.filter((w) => w.isActive).length).toBeGreaterThan(0);
	});

	it('installs the webhook disabled, so no contact details leave the instance', async () => {
		const t = convexTest(schema, modules);
		await install(t);

		const webhooks = await t.run(async (ctx) => await ctx.db.query('webhooks').collect());
		expect(webhooks.length).toBeGreaterThan(0);
		expect(webhooks.filter((w) => w.isActive)).toEqual([]);

		// The fixture URL is a host nobody configured; the delivery pool must not
		// consider the row a subscriber to the operator's own events.
		for (const event of ['contact.created', 'email.sent'] as const) {
			const subscribers = await t.query(internal.webhooks.deliveryQueries.getWebhooksForEvent, {
				event,
			});
			expect(subscribers).toEqual([]);
		}
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

	it('reports a scan it could not finish rather than under-counting silently', async () => {
		const t = convexTest(schema, modules);
		await install(t);

		const status = (await (await post(t, '/sample-data/status', SECRET)).json()) as {
			truncated: boolean;
		};
		const removed = (await (await post(t, '/sample-data/remove', SECRET)).json()) as {
			truncated: boolean;
		};
		// Nothing here is near the page cap, so both scans completed — the flag
		// exists so a caller can tell "nothing left" from "stopped looking".
		expect(status.truncated).toBe(false);
		expect(removed.truncated).toBe(false);
	});

	it('is a no-op on an instance that never installed sample data', async () => {
		const t = convexTest(schema, modules);
		const res = await post(t, '/sample-data/remove', SECRET);
		expect(res.status).toBe(200);
		expect((await res.json()) as { deleted: Record<string, number>; truncated: boolean }).toEqual({
			deleted: {},
			truncated: false,
		});
	});
});
