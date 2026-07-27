import { convexTest } from 'convex-test';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import schema from '../../schema';
import { loadSeedAccounts } from '../seedPlacement';
import {
	isSeedProbeId,
	SEED_PROBE_HEADER,
	toSeedAccountLogView,
} from '@owlat/shared/seedPlacement';
import { buildSeedShadowEnvelope } from '../../delivery/seedShadowCopy';
import type { CampaignEnvelopeInput } from '../../delivery/seedShadowCopy';
import { buildComposeInput } from '../../delivery/worker';
import { composeForSend } from '../../delivery/sendComposition';
import type { Id } from '../../_generated/dataModel';
import { modules } from './testModules';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const schemaSource = readFileSync(here('../../schema/seedPlacement.ts'), 'utf8');

const NOW = 1_800_000_000_000;
const ORG = 'org_seed_secrets';

/**
 * A connected seed mailbox, credentials and all — so the projection assertion
 * below is made against a row that really does hold a sealed secret.
 */
async function seedFixture(t: ReturnType<typeof convexTest>): Promise<void> {
	await t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId: ORG,
			address: 'owlat.seed.01@gmail.example',
			domain: 'gmail.example',
			kind: 'external' as const,
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
		await ctx.db.insert('externalMailAccounts', {
			userId: 'user_1',
			organizationId: ORG,
			mailboxId,
			purpose: 'seed' as const,
			seedProvider: 'gmail' as const,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 587,
			isSmtpSecure: false,
			authMethod: 'password' as const,
			imapUsername: 'seed-login-01',
			secretCiphertext: 'CIPHERTEXT_MUST_NEVER_LEAK',
			secretIv: 'IV_MUST_NEVER_LEAK',
			secretAuthTag: 'TAG_MUST_NEVER_LEAK',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

// Set at MODULE scope: the probe-header suite below composes inside a
// `describe` body, which vitest runs at COLLECTION time — a `beforeAll` would
// be too late and the file would collect zero tests.
const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';
afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
});

/** (e) Credentials are sealed and never logged. */
describe('seed credentials', () => {
	it('never leaves the sealed envelope: the seed projection carries no secret', async () => {
		const t = convexTest(schema, modules);
		await seedFixture(t);
		const accounts = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(accounts).toHaveLength(1);
		const projected = JSON.stringify(accounts);
		for (const secret of ['CIPHERTEXT', 'IV_MUST', 'TAG_MUST', 'seed-login-01']) {
			expect(projected).not.toContain(secret);
		}
		// Only the fields the prober actually needs, and the ADDRESS comes from
		// the linked mailbox — never the IMAP login.
		expect(Object.keys(accounts[0] ?? {}).sort()).toEqual([
			'accountId',
			'address',
			'connectedAt',
			'provider',
			'rotationReminderDue',
		]);
		expect(accounts[0]?.address).toBe('owlat.seed.01@gmail.example');
	});

	it('defines no second credential model — seeds are ordinary external accounts', () => {
		expect(schemaSource).toContain("v.id('externalMailAccounts')");
		expect(schemaSource).not.toContain('password');
	});

	it('logs a seed account only as provider + domain, never the address or a secret', () => {
		const view = toSeedAccountLogView({
			accountId: 'acct_1',
			provider: 'gmail',
			address: 'Owlat.Seed.01@Gmail.Example',
		});
		expect(view).toEqual({ accountId: 'acct_1', provider: 'gmail', domain: 'gmail.example' });
		expect(JSON.stringify(view)).not.toContain('owlat.seed.01');
	});

	it('degrades safely on a malformed address', () => {
		expect(
			toSeedAccountLogView({ accountId: 'a', provider: 'other', address: 'not-an-address' }).domain
		).toBe('');
	});
});

/** (e) Mailbox CONTENTS are never logged — or even stored. */
describe('seed mailbox contents', () => {
	it('never enters Convex: the ledger stores a folder NAME and timestamps only', () => {
		for (const field of ['subject', 'bodyHtml', 'bodyText', 'snippet', 'rawMessage']) {
			expect(schemaSource).not.toContain(`${field}:`);
		}
		expect(schemaSource).toContain('folderName');
	});

	it('is not part of the ledger row a classification writes', async () => {
		const t = convexTest(schema, modules);
		await seedFixture(t);
		const stored = await t.run(async (ctx) => {
			const account = await ctx.db.query('externalMailAccounts').first();
			if (!account) throw new Error('fixture missing');
			const id = await ctx.db.insert('seedPlacementProbes', {
				organizationId: ORG,
				probeId: 'sp_a1b2c3d4e5f60718293a4b',
				accountId: account._id,
				provider: 'gmail',
				stream: 'campaign',
				sentAt: NOW,
				expiresAt: NOW + 1,
				placement: 'spam',
				folderName: '[Gmail]/Spam',
				classifiedAt: NOW,
			});
			return ctx.db.get(id);
		});
		const keys = Object.keys(stored ?? {});
		for (const field of ['subject', 'bodyHtml', 'bodyText', 'snippet', 'rawMessage']) {
			expect(keys).not.toContain(field);
		}
	});
});

/** (e) The probe header carries no PII and never reaches a real recipient. */
describe('the probe header', () => {
	const realSend: CampaignEnvelopeInput = {
		kind: 'campaign',
		to: 'jane@example.com',
		from: 'news@org.example',
		template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
		contactInfo: {
			contactId: 'contact1' as Id<'contacts'>,
			email: 'jane@example.com',
			firstName: 'Jane',
		},
		emailSendId: 'send1' as Id<'emailSends'>,
		campaignId: 'campaign1' as Id<'campaigns'>,
		organizationId: 'org_1',
		convexSiteUrl: 'https://convex.example',
		siteUrl: 'https://app.example',
	};
	const probeId = 'sp_a1b2c3d4e5f60718293a4b';
	const shadow = buildSeedShadowEnvelope(realSend, {
		address: 'owlat.seed.01@gmail.example',
		probeId,
		probeRef: 'probe1' as Id<'seedPlacementProbes'>,
	});
	const headerValue = composeForSend(buildComposeInput(shadow)).headers[SEED_PROBE_HEADER];

	it('is an opaque id', () => {
		expect(headerValue).toBe(probeId);
		expect(isSeedProbeId(headerValue ?? '')).toBe(true);
	});

	it('leaks no recipient PII', () => {
		expect(headerValue).not.toContain('jane');
		expect(headerValue).not.toContain('example.com');
		expect(headerValue).not.toContain('contact1');
		expect(headerValue).not.toContain('owlat.seed.01');
	});

	it('leaks no campaign PII', () => {
		expect(headerValue).not.toContain('campaign1');
		expect(headerValue).not.toContain('Hello');
		expect(headerValue).not.toContain('org_1');
	});

	it('never reaches a real recipient — a countable Send cannot carry it', () => {
		const realHeaders = composeForSend(buildComposeInput(realSend)).headers;
		expect(realHeaders[SEED_PROBE_HEADER]).toBeUndefined();
		// And the reverse invariant: an envelope carrying the probe header has no
		// emailSendId, so it can never be dispatched as a countable Send.
		expect(shadow.emailSendId).toBeUndefined();
	});
});
