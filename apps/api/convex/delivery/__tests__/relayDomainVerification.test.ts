/**
 * Relay-domain verification through the sending-domain provider registry (D7).
 *
 * `relayDomainVerified` used to open with `relayProviderType !== 'ses' → false`
 * and inline SES's proof. It now dispatches to the registered provider for the
 * relay kind, which has to leave three things exactly where they were:
 *
 *   - SES's verdict, on the full proof and on every way it can be incomplete;
 *   - the honest "unverifiable" answer for kinds with no identity API
 *     (`smtp`, `resend`) and for the owned MTA, which is never a relay;
 *   - the same answer for a kind this deployment has never heard of.
 *
 * P3.1 added the second kind that CAN answer — Mandrill, from the generic
 * identity table — so the last block covers it as its own proof rather than as
 * the "unknown kind" placeholder it used to be.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { MANDRILL_RELAY_PROOF_MAX_AGE_MS, SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import schema from '../../schema';
import { relayDomainVerified } from '../../lib/sendProviders/relayDomainVerification';
import type { DatabaseWriter } from '../../_generated/server';

import { modules } from '../../__tests__/testModules';

const DOMAIN = 'sender.example.com';
const NOW = 1_800_000_000_000;

type SesIdentityOverrides = Partial<{
	dnsRecords: Record<string, unknown>;
	verificationResults: Record<string, unknown>;
	isProviderVerified: boolean;
	verifiedAt: number;
	spfProofState: 'dns_required' | 'not_applicable_manual_primary';
}>;

/**
 * An MTA-primary domain plus a complete SES relay proof: DKIM tokens proven,
 * custom MAIL FROM proven, no apex SPF row (the manual-primary contract), all
 * observations fresh. Overrides let each test break exactly one requirement.
 */
async function seedSesRelay(
	ctx: { db: DatabaseWriter },
	overrides: SesIdentityOverrides = {}
): Promise<void> {
	const domainId = await ctx.db.insert('domains', {
		domain: DOMAIN,
		providerType: 'mta' as const,
		status: 'verified' as const,
		dnsRecords: {},
		createdAt: NOW,
		updatedAt: NOW,
	});
	await ctx.db.insert('sendingDomainSesIdentities', {
		domainId,
		dkimTokens: ['token-one'],
		verificationToken: 'proof',
		dnsRecords: {
			mailFrom: [{ type: 'MX' as const, host: 'bounce', value: 'feedback-smtp.example.com' }],
		},
		verificationResults: {
			dkim: [{ verified: true, lastChecked: NOW }],
			mailFrom: [{ verified: true, lastChecked: NOW }],
		},
		isProviderVerified: true,
		verifiedAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	});
}

function harness() {
	return convexTest(schema, modules);
}

describe('relayDomainVerified — SES (byte-identical)', () => {
	it('accepts a complete, fresh proof', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN, 'ses', NOW)).toBe(true);
		});
	});

	it('is case-insensitive on the From domain', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN.toUpperCase(), 'ses', NOW)).toBe(true);
		});
	});

	it('refuses a domain with no row at all', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			expect(await relayDomainVerified(ctx, DOMAIN, 'ses', NOW)).toBe(false);
		});
	});

	it('refuses a domain with no SES identity', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: DOMAIN,
				providerType: 'mta' as const,
				status: 'verified' as const,
				dnsRecords: {},
				createdAt: NOW,
				updatedAt: NOW,
			});
			expect(await relayDomainVerified(ctx, DOMAIN, 'ses', NOW)).toBe(false);
		});
	});

	it('refuses an identity SES itself has not verified', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx, { isProviderVerified: false });
			expect(await relayDomainVerified(ctx, DOMAIN, 'ses', NOW)).toBe(false);
		});
	});

	it('refuses a proof older than the max age', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(
				await relayDomainVerified(ctx, DOMAIN, 'ses', NOW + SES_RELAY_PROOF_MAX_AGE_MS + 1)
			).toBe(false);
		});
	});

	it('refuses an unproven DKIM token', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx, {
				verificationResults: {
					dkim: [{ verified: false, lastChecked: NOW }],
					mailFrom: [{ verified: true, lastChecked: NOW }],
				},
			});
			expect(await relayDomainVerified(ctx, DOMAIN, 'ses', NOW)).toBe(false);
		});
	});

	it('refuses when a published apex SPF row has no verified result', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx, {
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
					mailFrom: [{ type: 'MX', host: 'bounce', value: 'feedback-smtp.example.com' }],
				},
				verificationResults: {
					dkim: [{ verified: true, lastChecked: NOW }],
					mailFrom: [{ verified: true, lastChecked: NOW }],
				},
			});
			expect(await relayDomainVerified(ctx, DOMAIN, 'ses', NOW)).toBe(false);
		});
	});
});

describe('relayDomainVerified — kinds with no registered proof', () => {
	it('reports unverifiable for relay kinds with no identity API', async () => {
		// The seeded domain carries a COMPLETE SES proof. A `resend` or `smtp`
		// relay must still be unverifiable: one relay's proof is not another's.
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN, 'resend', NOW)).toBe(false);
			expect(await relayDomainVerified(ctx, DOMAIN, 'smtp', NOW)).toBe(false);
		});
	});

	it('reports unverifiable for the owned MTA', async () => {
		// `mta` HAS a registered sending-domain provider, so this is the case that
		// proves the seam asks for a relay proof rather than for mere
		// registration: the MTA adapter implements no `relayDomainVerified`.
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN, 'mta', NOW)).toBe(false);
		});
	});

	it('reports unverifiable for an unknown kind, without throwing', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN, 'postmark', NOW)).toBe(false);
			expect(await relayDomainVerified(ctx, DOMAIN, '', NOW)).toBe(false);
		});
	});
});

/**
 * MANDRILL (P3.1) — the second kind to answer this seam, and the proof that
 * "verifiable" now means "a registered provider says so" rather than "is SES".
 *
 * Its proof is a row in the GENERIC `sendingDomainRelayIdentities` table (D7)
 * rather than a per-provider sibling, and it is Mandrill's own verdict rather
 * than our DNS crawl — so the cases that can go wrong are different ones: a
 * status that is not `verified`, record verdicts that contradict it, and an
 * observation that has aged out.
 */
describe('relayDomainVerified — Mandrill', () => {
	async function seedMandrillIdentity(
		ctx: { db: DatabaseWriter },
		overrides: Partial<{
			status: 'unverified' | 'pending_dns' | 'verified' | 'failed';
			spf: { isValid: boolean };
			dkim: { isValid: boolean };
			lastCheckedAt: number;
		}> = {}
	): Promise<void> {
		await ctx.db.insert('sendingDomainRelayIdentities', {
			organizationId: 'org-a',
			domain: DOMAIN,
			providerKind: 'mandrill',
			status: 'verified' as const,
			spf: { isValid: true },
			dkim: { isValid: true },
			lastCheckedAt: NOW,
			nextCheckDueAt: NOW + 24 * 60 * 60 * 1000,
			createdAt: NOW,
			updatedAt: NOW,
			...overrides,
		});
	}

	it('accepts a fresh, verified identity', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedMandrillIdentity(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN, 'mandrill', NOW)).toBe(true);
			expect(await relayDomainVerified(ctx, DOMAIN.toUpperCase(), 'mandrill', NOW)).toBe(true);
		});
	});

	it('refuses an observation older than the max age', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedMandrillIdentity(ctx);
			expect(
				await relayDomainVerified(
					ctx,
					DOMAIN,
					'mandrill',
					NOW + MANDRILL_RELAY_PROOF_MAX_AGE_MS + 1
				)
			).toBe(false);
		});
	});

	it('refuses an identity that is not verified', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await seedMandrillIdentity(ctx, { status: 'pending_dns' });
			expect(await relayDomainVerified(ctx, DOMAIN, 'mandrill', NOW)).toBe(false);
		});
	});

	it('refuses a domain with no Mandrill identity, however verified it is at SES', async () => {
		// One relay's proof is not another's — the same rule the SES-only cases
		// above assert from the other side.
		const t = harness();
		await t.run(async (ctx) => {
			await seedSesRelay(ctx);
			expect(await relayDomainVerified(ctx, DOMAIN, 'mandrill', NOW)).toBe(false);
		});
	});
});
