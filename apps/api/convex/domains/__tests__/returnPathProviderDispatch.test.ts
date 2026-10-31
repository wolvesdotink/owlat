/**
 * The per-kind return-path answers, pinned across every shipped sending-domain
 * provider kind.
 *
 * Which kinds accept a custom return-path host, which hosts fit them, the exact
 * `mailFrom` bundle each publishes and which reflection action each schedules
 * are dispatched through the provider registry. These cases hold the answers
 * for `mta`, `ses`, `mandrill` and a legacy row with no recorded kind constant,
 * on all three paths that ask: the create-time check, the edit and the
 * post-registration reconcile.
 *
 * convex-test over the real lifecycle; nothing runs the scheduled actions, so
 * no provider client is reached.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';

const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
			path.replace(/^\.\.\//, '../../domains/'),
			mod,
		])
	),
};

const POOL_IP = '203.0.113.7';
const MAIL_HOST = 'mail.owlat.example';
const SES_REGION = 'eu-west-1';

const SEEDED_MAIL_FROM = [{ type: 'TXT', hostname: 'old.acme.com', value: 'v=spf1 -all' }];

beforeEach(() => {
	vi.stubEnv('MTA_IP_POOLS', POOL_IP);
	vi.stubEnv('EHLO_HOSTNAME', MAIL_HOST);
	vi.stubEnv('SPF_QUALIFIER', '-all');
	vi.stubEnv('MTA_RETURN_PATH_RELAY_SPF', '');
	vi.stubEnv('AWS_SES_REGION', SES_REGION);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

async function seedDomain(
	t: ReturnType<typeof convexTest>,
	providerType: string | undefined,
	overrides: Record<string, unknown> = {}
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('domains', {
			domain: 'acme.com',
			status: 'verified',
			...(providerType !== undefined ? { providerType } : {}),
			dnsRecords: { mailFrom: SEEDED_MAIL_FROM },
			createdAt: now,
			updatedAt: now,
			...overrides,
		});
	});
}

async function snapshot(t: ReturnType<typeof convexTest>, domainId: Id<'domains'>) {
	return await t.run(async (ctx) => {
		const domain = await ctx.db.get(domainId);
		const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
		return {
			status: domain?.status,
			returnPathHost: domain?.returnPathHost,
			mailFrom: (domain?.dnsRecords as { mailFrom?: unknown } | undefined)?.mailFrom,
			scheduled: scheduled.map((job) => ({ name: job.name, args: job.args[0] })),
		};
	});
}

const MTA_BUNDLE = (host: string) => [
	{ type: 'MX', hostname: host, value: MAIL_HOST, priority: 10 },
	{ type: 'TXT', hostname: host, value: `v=spf1 ip4:${POOL_IP} -all` },
];

const SES_BUNDLE = (label: string) => [
	{ type: 'MX', host: label, value: `feedback-smtp.${SES_REGION}.amazonses.com`, priority: 10 },
	{ type: 'TXT', host: label, value: 'v=spf1 include:amazonses.com ~all' },
];

describe('setReturnPathHost — the per-kind answer', () => {
	it('mta: publishes the pool-IP bundle with a bounce MX and schedules the MTA push', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'mta');
		const outcome = await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.elsewhere.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: true, returnPathHost: 'bounce.elsewhere.com', changed: true });
		const after = await snapshot(t, domainId);
		expect(after.status).toBe('pending');
		expect(after.mailFrom).toEqual(MTA_BUNDLE('bounce.elsewhere.com'));
		expect(after.scheduled).toEqual([
			{
				name: expect.stringContaining('pushReturnPathHost'),
				args: { domainId, returnPathHost: 'bounce.elsewhere.com', attempt: 0 },
			},
		]);
	});

	it('mta: with no pool IPs and no mail host there is nothing to publish, so mailFrom is dropped', async () => {
		vi.stubEnv('MTA_IP_POOLS', '');
		vi.stubEnv('EHLO_HOSTNAME', '');
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'mta');
		await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		const after = await snapshot(t, domainId);
		expect(after.mailFrom).toBeUndefined();
		expect(after.scheduled.map((job) => job.name)).toEqual([
			expect.stringContaining('pushReturnPathHost'),
		]);
	});

	it('ses: publishes the SES MAIL FROM pair on the subdomain label and schedules the SES reflection', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'ses');
		const outcome = await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.mail.acme.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: true, returnPathHost: 'bounce.mail.acme.com', changed: true });
		const after = await snapshot(t, domainId);
		expect(after.status).toBe('pending');
		expect(after.mailFrom).toEqual(SES_BUNDLE('bounce.mail'));
		expect(after.scheduled).toEqual([
			{
				name: expect.stringContaining('reflectSesMailFrom'),
				args: { domainId, returnPathHost: 'bounce.mail.acme.com', attempt: 0 },
			},
		]);
	});

	it('ses: refuses a host outside the sending domain and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'ses');
		const outcome = await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.elsewhere.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: false, reason: 'host_not_subdomain' });
		const after = await snapshot(t, domainId);
		expect(after).toEqual({
			status: 'verified',
			returnPathHost: undefined,
			mailFrom: SEEDED_MAIL_FROM,
			scheduled: [],
		});
	});

	it.each([
		['mandrill', 'mandrill'],
		['a legacy row with no recorded kind', undefined],
	])('%s: unsupported, and the row is left alone', async (_label, providerType) => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, providerType);
		const outcome = await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: false, reason: 'unsupported_provider' });
		const after = await snapshot(t, domainId);
		expect(after).toEqual({
			status: 'verified',
			returnPathHost: undefined,
			mailFrom: SEEDED_MAIL_FROM,
			scheduled: [],
		});
	});
});

describe('reconcileReturnPathAfterRegistration — the per-kind answer', () => {
	it.each([
		['mta', 'bounce.acme.com', MTA_BUNDLE('bounce.acme.com'), 'pushReturnPathHost'],
		['ses', 'bounce.acme.com', SES_BUNDLE('bounce'), 'reflectSesMailFrom'],
	] as const)(
		'%s: converges the records and the provider onto the stored host',
		async (kind, host, bundle, action) => {
			const t = convexTest(schema, modules);
			const domainId = await seedDomain(t, kind, { status: 'pending', returnPathHost: host });
			await t.mutation(internal.domains.lifecycleReturnPath.reconcileReturnPathAfterRegistration, {
				domainId,
				registeredReturnPathHost: 'old.acme.com',
				userId: 'user',
			});
			const after = await snapshot(t, domainId);
			expect(after.mailFrom).toEqual(bundle);
			expect(after.scheduled).toEqual([
				{
					name: expect.stringContaining(action),
					args: { domainId, returnPathHost: host, attempt: 0 },
				},
			]);
		}
	);

	it('mandrill: does nothing', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'mandrill', {
			status: 'pending',
			returnPathHost: 'bounce.acme.com',
		});
		await t.mutation(internal.domains.lifecycleReturnPath.reconcileReturnPathAfterRegistration, {
			domainId,
			registeredReturnPathHost: 'old.acme.com',
			userId: 'user',
		});
		const after = await snapshot(t, domainId);
		expect(after.mailFrom).toEqual(SEEDED_MAIL_FROM);
		expect(after.scheduled).toEqual([]);
	});
});

describe('lifecycle.create — the up-front return-path check per kind', () => {
	it.each([
		['mta', 'bounce.elsewhere.com', true],
		['ses', 'bounce.acme.com', true],
		['ses', 'bounce.elsewhere.com', 'return_path_not_subdomain'],
		['mandrill', 'bounce.acme.com', 'return_path_unsupported'],
	] as const)('%s with %s → %s', async (kind, host, expected) => {
		vi.stubEnv('EMAIL_PROVIDER', kind);
		const t = convexTest(schema, modules);
		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'acme.com',
			userId: 'user',
			returnPathHost: host,
		});
		if (expected === true) {
			expect(outcome.ok).toBe(true);
			const rows = await t.run(async (ctx) => await ctx.db.query('domains').collect());
			expect(rows.map((row) => [row.providerType, row.returnPathHost])).toEqual([[kind, host]]);
		} else {
			expect(outcome).toEqual({ ok: false, reason: expected });
			const rows = await t.run(async (ctx) => await ctx.db.query('domains').collect());
			expect(rows).toEqual([]);
		}
	});
});
