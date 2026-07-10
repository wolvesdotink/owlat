/**
 * Post-import "switch your sending" (outbound-only, gated).
 *
 * End-to-end over a real (convex-test) datastore for the piece c4 surface on
 * `mail/externalAccounts`:
 *   - the prompt gating matrix (`sendingSwitchStatus`): a switch is offered ONLY
 *     when import + knowledge indexing are done, the from-domain is a VERIFIED
 *     sending domain on this instance, and a transport is configured. Missing
 *     any one → no prompt. An unverified domain is never offered (no spoofing).
 *   - `setSendingPreference` round-trips both directions and completes the
 *     `sendingSwitched` onboarding step on the switch to instance; the switch is
 *     refused (throws) for an unverified domain or with no transport.
 *   - dispatch honours the preference: `resolveOutboundTransport` returns the
 *     external SMTP path by default and the hosted/instance path once switched.
 *
 * `isDeliveryConfigured` is mocked to a hoisted flag so "transport configured"
 * is controllable; the verified-domain gate is exercised with real `domains`
 * rows.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { markOnboardingStep } from '../../auth/userOnboarding';
import type { Id } from '../../_generated/dataModel';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

const capabilityMocks = vi.hoisted(() => ({
	deliveryConfigured: true,
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: sessionMocks.userId, role: sessionMocks.role })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

vi.mock('../../lib/sendProviders/capability', async () => {
	const actual = await vi.importActual('../../lib/sendProviders/capability');
	return {
		...actual,
		isDeliveryConfigured: vi.fn(async () => capabilityMocks.deliveryConfigured),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agentSecurity') &&
				!path.includes('agentContext') &&
				!path.includes('agentClassifier') &&
				!path.includes('agentDrafter') &&
				!path.includes('agentRouter') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/shared') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

/** IMAP/SMTP credentials for `_connectInternal` (ciphertext bytes are dummy). */
const CREDS = {
	emailAddress: 'me@example.com',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'me@example.com',
	authMethod: 'password' as const,
	secretCiphertext: 'ZmFrZS1jaXBoZXI=',
	secretIv: 'ZmFrZS1pdg==',
	secretAuthTag: 'ZmFrZS10YWc=',
	secretEnvelopeVersion: 1,
};

type Ctx = ReturnType<typeof convexTest>;

async function enableFlags(t: Ctx, flags: Record<string, boolean>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', { featureFlags: flags, createdAt: Date.now() });
	});
}

async function seedVerifiedDomain(t: Ctx, domain: string): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('domains', {
			domain,
			status: 'verified',
			dnsRecords: {},
			lastVerifiedAt: now,
			verifiedAt: now,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/** Connect user-A's external mailbox and return its mailbox id. */
async function connectMailbox(t: Ctx): Promise<Id<'mailboxes'>> {
	await t.mutation(internal.mail.externalAccounts._connectInternal, CREDS);
	return await t.run(async (ctx) => {
		const account = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', sessionMocks.userId))
			.first();
		if (!account) throw new Error('external account not created');
		return account.mailboxId;
	});
}

/** Mark import + knowledge indexing complete for the current user. */
async function markImportAndIndexingDone(t: Ctx): Promise<void> {
	await t.run(async (ctx) => {
		await markOnboardingStep(ctx, sessionMocks.userId, 'importDone');
		await markOnboardingStep(ctx, sessionMocks.userId, 'knowledgeIndexed');
	});
}

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'editor';
	capabilityMocks.deliveryConfigured = true;
});

describe('sendingSwitchStatus — prompt gating matrix', () => {
	it('offers the switch when import + indexing done, domain verified, transport configured', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connectMailbox(t);
		await markImportAndIndexingDone(t);
		await seedVerifiedDomain(t, 'example.com');

		const status = await t.query(api.mail.externalAccounts.sendingSwitchStatus, {});
		expect(status.configured).toBe(true);
		if (!status.configured) return;
		expect(status.preference).toBe('external');
		expect(status.domainVerified).toBe(true);
		expect(status.transportConfigured).toBe(true);
		expect(status.promptEligible).toBe(true);
	});

	it('never offers the switch for an unverified domain (no gmail.com spoofing)', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connectMailbox(t);
		await markImportAndIndexingDone(t);
		// No verified `domains` row for example.com.

		const status = await t.query(api.mail.externalAccounts.sendingSwitchStatus, {});
		expect(status.configured).toBe(true);
		if (!status.configured) return;
		expect(status.domainVerified).toBe(false);
		expect(status.promptEligible).toBe(false);
	});

	it('does not offer the switch when no transport is configured', async () => {
		const t = convexTest(schema, modules);
		capabilityMocks.deliveryConfigured = false;
		await enableFlags(t, { 'mail.external': true });
		await connectMailbox(t);
		await markImportAndIndexingDone(t);
		await seedVerifiedDomain(t, 'example.com');

		const status = await t.query(api.mail.externalAccounts.sendingSwitchStatus, {});
		expect(status.configured).toBe(true);
		if (!status.configured) return;
		expect(status.transportConfigured).toBe(false);
		expect(status.promptEligible).toBe(false);
	});

	it('does not offer the switch before import + indexing are done', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connectMailbox(t);
		await seedVerifiedDomain(t, 'example.com');
		// importDone / knowledgeIndexed intentionally unset.

		const status = await t.query(api.mail.externalAccounts.sendingSwitchStatus, {});
		expect(status.configured).toBe(true);
		if (!status.configured) return;
		expect(status.domainVerified).toBe(true);
		expect(status.transportConfigured).toBe(true);
		expect(status.promptEligible).toBe(false);
	});
});

describe('setSendingPreference — round-trips and gating', () => {
	it('switches to instance and back, and stamps sendingSwitched on the instance switch', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const mailboxId = await connectMailbox(t);
		await seedVerifiedDomain(t, 'example.com');

		const toInstance = await t.mutation(api.mail.externalAccounts.setSendingPreference, {
			preference: 'instance',
		});
		expect(toInstance.preference).toBe('instance');
		await t.run(async (ctx) => {
			const mb = await ctx.db.get(mailboxId);
			expect(mb?.outboundPreference).toBe('instance');
		});
		let onboarding = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof onboarding.sendingSwitched).toBe('number');

		const toExternal = await t.mutation(api.mail.externalAccounts.setSendingPreference, {
			preference: 'external',
		});
		expect(toExternal.preference).toBe('external');
		await t.run(async (ctx) => {
			const mb = await ctx.db.get(mailboxId);
			expect(mb?.outboundPreference).toBe('external');
		});
		// Reverting leaves the checklist decision recorded.
		onboarding = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof onboarding.sendingSwitched).toBe('number');
	});

	it('refuses the instance switch for an unverified domain', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connectMailbox(t);
		// No verified domain row.

		await expect(
			t.mutation(api.mail.externalAccounts.setSendingPreference, { preference: 'instance' })
		).rejects.toThrow();
	});

	it('refuses the instance switch when no transport is configured', async () => {
		const t = convexTest(schema, modules);
		capabilityMocks.deliveryConfigured = false;
		await enableFlags(t, { 'mail.external': true });
		await connectMailbox(t);
		await seedVerifiedDomain(t, 'example.com');

		await expect(
			t.mutation(api.mail.externalAccounts.setSendingPreference, { preference: 'instance' })
		).rejects.toThrow();
	});
});

describe('resolveOutboundTransport — dispatch honours the preference', () => {
	it('sends through the external SMTP path by default', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const mailboxId = await connectMailbox(t);

		const transport = await t.query(internal.mail.externalAccounts.resolveOutboundTransport, {
			mailboxId,
		});
		expect(transport.kind).toBe('external');
	});

	it('sends through the instance/hosted path once switched', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const mailboxId = await connectMailbox(t);
		await seedVerifiedDomain(t, 'example.com');
		await t.mutation(api.mail.externalAccounts.setSendingPreference, { preference: 'instance' });

		const transport = await t.query(internal.mail.externalAccounts.resolveOutboundTransport, {
			mailboxId,
		});
		expect(transport.kind).toBe('hosted');
	});
});
