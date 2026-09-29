/**
 * v0.6.3 compatibility shims at `domains/lifecycle` — remove after release N+1.
 *
 * Three editors moved out of `lifecycle.ts`. v0.6.3's registration, return-path
 * push and webhook dispatcher actions still call them at the old path while
 * they finish across a deploy, so the old path must keep working and land the
 * same write as the new one.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';

// `'../../**'` from `domains/__tests__` skips the sibling `domains/*` modules;
// merge a `domains/`-rooted glob re-prefixed to the same form. The provider
// register actions stay out: they need MTA/SES credentials.
const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...domainsGlob }).filter(
		([path]) => !path.includes('providers/registerAction')
	)
);

async function seedMtaDomain(
	t: ReturnType<typeof convexTest>,
	fields: { domain: string; returnPathHost?: string; returnPathHostSyncError?: string }
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('domains', {
			status: 'pending',
			dnsRecords: {
				dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=OLDKEY' }],
				dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
			},
			providerType: 'mta',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...fields,
		})
	);
}

async function auditActions(t: ReturnType<typeof convexTest>, domainId: Id<'domains'>) {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect()
		).map((row) => ({ action: row.action, applied: row.details?.['applied'] }))
	);
}

describe('domains/lifecycle previous-release shims', () => {
	it('recordDkimRotation at the old path rotates the DKIM records', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t, { domain: 'rotate.example' });

		const outcome = await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'rotate.example',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'activated',
			userId: 'system:dkim_rotation',
		});

		expect(outcome).toEqual({ ok: true, phase: 'activated', selector: 's2', changed: true });
		const row = await t.run(async (ctx) => ctx.db.get(domainId));
		expect(row!.dnsRecords.dkim).toEqual([
			{ type: 'TXT', host: 's2._domainkey', value: 'v=DKIM1; k=rsa; p=NEWKEY' },
		]);
		expect((await auditActions(t, domainId)).map((a) => a.action)).toEqual([
			'sending_domain.dkim_rotated',
		]);
	});

	it('recordDkimRotation at the old path still reports an unknown domain', async () => {
		const t = convexTest(schema, modules);
		const outcome = await t.mutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: 'missing.example',
			selector: 's2',
			dnsRecord: 'v=DKIM1; k=rsa; p=NEWKEY',
			phase: 'pending',
			userId: 'system:dkim_rotation',
		});
		expect(outcome).toEqual({ ok: false, reason: 'domain_not_found' });
	});

	it('recordReturnPathPushResult at the old path records a give-up', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t, {
			domain: 'push.example',
			returnPathHost: 'bounce.push.example',
		});

		await t.mutation(internal.domains.lifecycle.recordReturnPathPushResult, {
			domainId,
			returnPathHost: 'bounce.push.example',
			error: 'MTA returned 503',
			attempts: 5,
			userId: 'system:return_path_push',
		});

		const row = await t.run(async (ctx) => ctx.db.get(domainId));
		expect(row!.returnPathHostSyncError).toBe('MTA returned 503');
		expect(await auditActions(t, domainId)).toEqual([
			{ action: 'sending_domain.return_path_changed', applied: 'sync_failed' },
		]);
	});

	it('reconcileReturnPathAfterRegistration at the old path converges on the stored host', async () => {
		// The reconcile schedules the MTA push, which this module map leaves out.
		expectScheduledFailure('domains/providers/registerAction:pushReturnPathHost');
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t, {
			domain: 'reconcile.example',
			returnPathHost: 'bounce-new.reconcile.example',
			returnPathHostSyncError: 'stale',
		});

		await t.mutation(internal.domains.lifecycle.reconcileReturnPathAfterRegistration, {
			domainId,
			registeredReturnPathHost: 'bounce-old.reconcile.example',
			userId: 'system:registration',
		});

		const row = await t.run(async (ctx) => ctx.db.get(domainId));
		expect(row!.returnPathHostSyncError).toBeUndefined();
		expect(await auditActions(t, domainId)).toEqual([
			{ action: 'sending_domain.return_path_changed', applied: 'reconciled_after_registration' },
		]);
	});
});
