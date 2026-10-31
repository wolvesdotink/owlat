/**
 * What `registerAction.run` leaves on the domain row, for each way a
 * registration can end: the provider refused, the outcome itself could not be
 * written, the post-registration return-path repair threw, or the result
 * arrived after the domain had moved on.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type * as MtaIdentityModule from '../../lib/emailProviders/mtaIdentity';
import type * as ReturnPathProvidersModule from '../returnPathProviders';

const { registerDomainMock, reconcileFault } = vi.hoisted(() => ({
	registerDomainMock: vi.fn(),
	reconcileFault: { isActive: false, reflectionThrows: false },
}));

vi.mock('../../lib/emailProviders/mtaIdentity', async (importActual) => {
	const actual = await importActual<typeof MtaIdentityModule>();
	return {
		...actual,
		createMtaIdentityManager: () => ({ registerDomain: registerDomainMock, deleteDomain: vi.fn() }),
	};
});

// Only the record builder and the reflection scheduler of the provider's
// return-path support are wrapped, so a test can make the post-registration
// repair throw before it writes (a misconfigured provider) or after (a
// scheduling failure).
vi.mock('../returnPathProviders', async (importActual) => {
	const actual = await importActual<typeof ReturnPathProvidersModule>();
	return {
		...actual,
		returnPathProviderFor: (...args: Parameters<typeof actual.returnPathProviderFor>) => {
			const returnPath = actual.returnPathProviderFor(...args);
			if (returnPath === null) return null;
			return {
				...returnPath,
				mailFromRecords: (...recordArgs: Parameters<typeof returnPath.mailFromRecords>) => {
					if (reconcileFault.isActive) throw new Error('AWS_SES_REGION is not set');
					return returnPath.mailFromRecords(...recordArgs);
				},
				scheduleReflection: (...reflectArgs: Parameters<typeof returnPath.scheduleReflection>) => {
					if (reconcileFault.reflectionThrows) throw new Error('scheduler unavailable');
					return returnPath.scheduleReflection(...reflectArgs);
				},
			};
		},
	};
});

const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([p, m]) => [
			p.replace(/^\.\.\//, '../../domains/'),
			m,
		])
	),
};

type TestConvex = ReturnType<typeof convexTest>;

beforeEach(() => {
	registerDomainMock.mockReset();
	registerDomainMock.mockResolvedValue({ selector: 's1', dnsRecord: 'v=DKIM1; k=rsa; p=KEY' });
	reconcileFault.isActive = false;
	reconcileFault.reflectionThrows = false;
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	vi.stubEnv('MTA_API_URL', 'http://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('MTA_IP_POOLS', '203.0.113.7');
	vi.stubEnv('EHLO_HOSTNAME', 'mail.owlat.test');
	vi.stubEnv('SPF_QUALIFIER', '~all');
	vi.stubEnv('MTA_SPF_INCLUDE', '');
	vi.stubEnv('MTA_TLSRPT_RUA', '');
	vi.stubEnv('MTA_DMARC_RUA', '');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function seedRegistering(t: TestConvex, returnPathHost?: string): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('domains', {
			domain: 'acme.example.com',
			status: 'registering',
			providerType: 'mta',
			...(returnPathHost ? { returnPathHost } : {}),
			dnsRecords: {},
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function register(t: TestConvex, domainId: Id<'domains'>): Promise<void> {
	await t.action(internal.domains.providers.registerAction.run, { providerType: 'mta', domainId });
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function readDomain(t: TestConvex, domainId: Id<'domains'>) {
	return await t.run(async (ctx) => ctx.db.get(domainId));
}

async function auditActions(t: TestConvex): Promise<string[]> {
	const rows = await t.run(async (ctx) => ctx.db.query('auditLogs').collect());
	return rows.map((row) => row.action);
}

describe('registerAction.run writes one outcome per registration', () => {
	it('lands pending with the provider records and identity', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRegistering(t);

		await register(t, domainId);

		const domain = await readDomain(t, domainId);
		expect(domain?.status).toBe('pending');
		expect((domain!.dnsRecords as { dkim?: unknown[] }).dkim).toHaveLength(1);
		const identity = await t.run(async (ctx) =>
			ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId))
				.first()
		);
		expect(identity?.dkimSelector).toBe('s1');
		expect(await auditActions(t)).toEqual(['sending_domain.registered']);
	});

	it('lands failed with the provider error when the provider refuses', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRegistering(t);
		registerDomainMock.mockRejectedValue(new Error('MTA unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await register(t, domainId);

		const domain = await readDomain(t, domainId);
		expect(domain?.status).toBe('failed');
		expect(domain?.lastRegistrationError).toBe('MTA unavailable');
		expect(await auditActions(t)).toEqual(['sending_domain.registration_failed']);
	});

	it('lands failed when the provider answer cannot be written as pending', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRegistering(t);
		// A record value that is not a string fails the transition's validator,
		// so the pending outcome is never written.
		registerDomainMock.mockResolvedValue({ selector: 's1', dnsRecord: 42 });
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await register(t, domainId);

		const domain = await readDomain(t, domainId);
		expect(domain?.status).toBe('failed');
		expect(domain?.lastRegistrationError).toBeTruthy();
		expect(await auditActions(t)).toEqual(['sending_domain.registration_failed']);
	});

	it('keeps a registered domain pending when the return-path repair throws', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRegistering(t, 'bounce.old.example.com');
		registerDomainMock.mockImplementation(async () => {
			// An edit commits while the provider call is in flight, so the repair
			// has a host to rebuild records for, and rebuilding them throws.
			await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
				domainId,
				returnPathHost: 'bounce.new.example.com',
				userId: 'user',
			});
			reconcileFault.isActive = true;
			return { selector: 's1', dnsRecord: 'v=DKIM1; k=rsa; p=KEY' };
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await register(t, domainId).catch(() => undefined);

		const domain = await readDomain(t, domainId);
		expect(domain?.status).toBe('pending');
		expect(domain?.returnPathHost).toBe('bounce.new.example.com');
		expect((domain!.dnsRecords as { dkim?: unknown[] }).dkim).toHaveLength(1);
		expect(await auditActions(t)).not.toContain('sending_domain.registration_failed');
	});

	it('rolls the whole registration back when the repair throws after its patch', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRegistering(t, 'bounce.old.example.com');
		registerDomainMock.mockImplementation(async () => {
			await t.mutation(internal.domains.lifecycleReturnPath.setReturnPathHost, {
				domainId,
				returnPathHost: 'bounce.new.example.com',
				userId: 'user',
			});
			reconcileFault.reflectionThrows = true;
			return { selector: 's1', dnsRecord: 'v=DKIM1; k=rsa; p=KEY' };
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await register(t, domainId);

		// Neither the outcome nor the repaired records survive without the
		// reflection; the separate failure commit leaves the domain retryable.
		const domain = await readDomain(t, domainId);
		expect(domain?.status).toBe('failed');
		expect((domain!.dnsRecords as { dkim?: unknown[] }).dkim).toBeUndefined();
		expect(await auditActions(t)).not.toContain('sending_domain.registered');
	});

	it('refuses a late result for a domain that is no longer registering', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedRegistering(t);
		await t.run(async (ctx) => ctx.db.patch(domainId, { status: 'verified' }));

		const outcome = await t.mutation(internal.domains.providers.registerCommit.commitRegistration, {
			domainId,
			input: { to: 'failed', at: Date.now(), error: 'late provider error' },
			userId: 'system:provider_register',
		});

		expect(outcome).toMatchObject({ ok: false, reason: 'illegal_edge', from: 'verified' });
		const domain = await readDomain(t, domainId);
		expect(domain?.status).toBe('verified');
		expect(domain?.lastRegistrationError).toBeUndefined();
		expect(await auditActions(t)).toEqual([]);
	});
});
