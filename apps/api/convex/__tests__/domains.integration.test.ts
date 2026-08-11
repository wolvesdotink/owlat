import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestDomain } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
	};
});

// Exclude provider register actions from modules to prevent convex-test from
// auto-executing scheduled 'use node' actions that require AWS / MTA
// credentials unavailable in tests. Lifecycle effects schedule these — we
// still cover the scheduling itself via `t.finishInProgressScheduledFunctions`.
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('providers/registerAction'))
);

// ============ domains.create (integration) ============

describe('domains.create', () => {
	it('should create domain with registering status', async () => {
		const t = convexTest(schema, modules);

		const domainId = await t.mutation(api.domains.domains.create, {
			domain: 'example.com',
		});

		expect(domainId).toBeDefined();

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain).toBeDefined();
			expect(domain!.status).toBe('registering');
			expect(domain!.domain).toBe('example.com');
			expect(domain!.createdAt).toBeTypeOf('number');
			expect(domain!.updatedAt).toBeTypeOf('number');
			expect(domain!.dnsRecords).toEqual({});
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	});

	it('should reject invalid domain format', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.domains.domains.create, {
				domain: 'not a domain',
			})
		).rejects.toThrow(/Invalid domain format/);
	});

	it('should reject duplicate domains', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.domains.domains.create, {
			domain: 'example.com',
		});

		await expect(
			t.mutation(api.domains.domains.create, {
				domain: 'example.com',
			})
		).rejects.toThrow(/already been added/);

		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	});

	it('should lowercase domain name', async () => {
		const t = convexTest(schema, modules);

		const domainId = await t.mutation(api.domains.domains.create, {
			domain: 'Example.COM',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.domain).toBe('example.com');
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	});
});

// ============ domains.listVerified (integration) ============

describe('domains.listVerified', () => {
	it('should return only verified domains', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({ status: 'verified', domain: 'verified.com', verifiedAt: Date.now() })
			);
			await ctx.db.insert(
				'domains',
				createTestDomain({ status: 'pending', domain: 'pending.com' })
			);
			await ctx.db.insert('domains', createTestDomain({ status: 'failed', domain: 'failed.com' }));
		});

		const verified = await t.query(api.domains.domains.listVerified, {});

		expect(verified).toHaveLength(1);
		expect(verified[0]!.domain).toBe('verified.com');
		expect(verified[0]!._id).toBeDefined();
		expect(verified[0]!.verifiedAt).toBeDefined();
	});

	it('should return empty array when none verified', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('domains', createTestDomain({ status: 'pending', domain: 'one.com' }));
		});

		const verified = await t.query(api.domains.domains.listVerified, {});

		expect(verified).toHaveLength(0);
	});
});

// ============ domains.remove (integration) ============

describe('domains.remove', () => {
	it('should remove domain', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;

		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', createTestDomain());
		});

		await t.mutation(api.domains.domains.remove, { domainId: domainId! });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain).toBeNull();
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	});

	it('should throw for non-existent domain', async () => {
		const t = convexTest(schema, modules);

		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', createTestDomain());
			await ctx.db.delete(domainId);
		});

		await expect(t.mutation(api.domains.domains.remove, { domainId: domainId! })).rejects.toThrow(
			/Domain not found/
		);
	});
});

// ============ domains.regenerateDnsRecords (integration) ============

describe('domains.regenerateDnsRecords', () => {
	it('should reset status to registering and clear verification data', async () => {
		const t = convexTest(schema, modules);
		let domainId: Id<'domains'>;

		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'regen.com',
					status: 'verified',
					providerType: 'ses',
					verifiedAt: Date.now(),
					verificationResults: { spf: { verified: true, lastChecked: Date.now() } },
				})
			);
			// Seed a sibling identity row to mirror real state.
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId: domainId,
				dkimTokens: ['token1', 'token2', 'token3'],
				verificationToken: 'old-token',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(api.domains.domains.regenerateDnsRecords, { domainId: domainId! });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('registering');
			expect(domain!.verificationResults).toBeUndefined();
			expect(domain!.verifiedAt).toBeUndefined();
			expect(domain!.dnsRecords).toEqual({});

			// Sibling identity row should be cleared by the lifecycle.
			const identities = await ctx.db
				.query('sendingDomainSesIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId!))
				.collect();
			expect(identities).toHaveLength(0);
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	});
});

// ============ domains.getEmailDomainVerificationStatus (integration) ============

describe('domains.getEmailDomainVerificationStatus', () => {
	it('should return verified status for verified domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.com',
					status: 'verified',
					lastVerifiedAt: Date.now(),
				})
			);
		});

		const result = await t.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: 'user@verified.com',
		});

		expect(result.domain).toBe('verified.com');
		expect(result.exists).toBe(true);
		expect(result.verified).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it('should return error for unregistered domain', async () => {
		const t = convexTest(schema, modules);

		const result = await t.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: 'user@unknown.com',
		});

		expect(result.domain).toBe('unknown.com');
		expect(result.exists).toBe(false);
		expect(result.verified).toBe(false);
		expect(result.error).toContain('not registered');
	});

	it('should return error for unverified domain', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'pending.com',
					status: 'pending',
				})
			);
		});

		const result = await t.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: 'user@pending.com',
		});

		expect(result.domain).toBe('pending.com');
		expect(result.exists).toBe(true);
		expect(result.verified).toBe(false);
		expect(result.error).toContain('not verified');
	});

	it('should handle angle bracket email format', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'bracket.com',
					status: 'verified',
					lastVerifiedAt: Date.now(),
				})
			);
		});

		const result = await t.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: '<user@bracket.com>',
		});

		expect(result.domain).toBe('bracket.com');
		expect(result.exists).toBe(true);
		expect(result.verified).toBe(true);
	});

	it('should return error for invalid email format', async () => {
		const t = convexTest(schema, modules);

		const result = await t.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: 'not-an-email',
		});

		expect(result.verified).toBe(false);
		expect(result.error).toContain('Invalid email address');
	});

	it('should check staleness within 24h window', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'stale-check.com',
					status: 'verified',
					lastVerifiedAt: Date.now() - 25 * 60 * 60 * 1000,
				})
			);
		});

		const result = await t.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: 'user@stale-check.com',
		});

		expect(result.verified).toBe(true);
		expect(result.stale).toBe(true);

		const t2 = convexTest(schema, modules);

		await t2.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'fresh-check.com',
					status: 'verified',
					lastVerifiedAt: Date.now() - 60000,
				})
			);
		});

		const freshResult = await t2.query(api.domains.domains.getEmailDomainVerificationStatus, {
			email: 'user@fresh-check.com',
		});

		expect(freshResult.verified).toBe(true);
		expect(freshResult.stale).toBe(false);
	});
});
