/**
 * Integration tests for the GDPR account lifecycle (auth/accountManagement.ts +
 * the batched member-erasure job in auth/memberErasure.ts).
 *
 * Covers:
 *  - exportUserData: requireSelf rejects a foreign userId; the export omits
 *    webhook secrets + api-key hashes; soft-deleted contacts are excluded;
 *    the api-key + webhook metadata sections are populated ONLY for an
 *    org admin/owner (empty for a plain 'editor').
 *  - the account-deletion path: a non-owner member's deletion erases their
 *    auth-side rows + onboarding + profile and hands off to the batched
 *    member-erasure walk; that walk anonymizes/erases the member's mailbox,
 *    app passwords, external credentials and chat authorship, then terminates
 *    by marking the deletion request `completed`.
 *
 * The BetterAuth `member` / `organization` rows that exportUserData and the
 * deletion path read are real component rows — seeded through the
 * `components.betterAuth.adapter.create` mutation after registering the
 * component with `t.registerComponent`.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ACCOUNT_EXPORT_ORGANIZATION_RESOURCES, type AccountExportResource } from '@owlat/shared';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { api, internal, components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isSealedBytesAtRest } from '../lib/atRestBodies';
import { sealBodyAtWrite } from '../lib/messageBody';
import { storeSealedBlob } from '../lib/sealedBlob';

const EXPORT_TEST_SECRET = 'gdpr-export-test-instance-secret-for-sealed-artifacts';
const EXPORT_TEST_SITE = 'https://gdpr-export-test.convex.site';

function tamperSealedTextBody(sealed: string): string {
	const envelopeParts = sealed.split(':');
	const ciphertextIndex = envelopeParts.length - 1;
	const ciphertext = Uint8Array.from(atob(envelopeParts[ciphertextIndex]!), (char) =>
		char.charCodeAt(0)
	);
	ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1;
	envelopeParts[ciphertextIndex] = btoa(String.fromCharCode(...ciphertext));
	return envelopeParts.join(':');
}

// The session is parameterized per test: requireSelf passes only for the
// fixed session user, and the caller's role (owner/admin/editor) decides
// whether exportUserData surfaces the admin-only api-key/webhook metadata.
const sessionMock = vi.hoisted(() => ({
	userId: 'auth-user-1',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

// requireSelf calls getUserIdFromSession through a *local* reference, so
// mocking the export alone doesn't intercept it — mock requireSelf directly.
// requireOrgMember / getMutationContext are the authedQuery/authedMutation
// floors and must succeed for the handler to run at all.
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.userId),
		requireSelf: vi.fn().mockImplementation(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMock.userId) {
				throw new Error('unauthenticated');
			}
			return sessionMock.userId;
		}),
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
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
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const betterAuthModules = import.meta.glob('../betterAuth/**/*.*s');

function newHarness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	sessionMock.userId = 'auth-user-1';
	sessionMock.role = 'owner';
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/** Seed a userProfiles row for the BetterAuth user id. */
async function seedProfile(
	t: TestConvex<typeof schema>,
	authUserId: string,
	email = 'me@example.com'
): Promise<Id<'userProfiles'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('userProfiles', {
			authUserId,
			email,
			name: 'Me',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/** Create a BetterAuth organization via the adapter; returns its _id. */
async function seedOrg(
	t: TestConvex<typeof schema>,
	name = 'Acme',
	metadata?: string
): Promise<string> {
	const org = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'organization',
			data: {
				name,
				slug: name.toLowerCase(),
				...(metadata === undefined ? {} : { metadata }),
				createdAt: Date.now(),
			},
		},
	} as never)) as { _id: string };
	return org._id;
}

/** Create a BetterAuth member row linking authUserId to org with a role. */
async function seedMember(
	t: TestConvex<typeof schema>,
	organizationId: string,
	authUserId: string,
	role: 'owner' | 'admin' | 'editor'
): Promise<void> {
	await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'member',
			data: { organizationId, userId: authUserId, role, createdAt: Date.now() },
		},
	} as never);
}

async function seedDeliverabilityAlertRecipients(
	t: TestConvex<typeof schema>,
	authUserId: string,
	count: number
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		const evidence = {
			organizationId: 'org-x',
			itemId: 'deployment.ptr' as const,
			scopeKind: 'deployment' as const,
			targetKey: '5:org-x|deployment',
			validator: 'gdpr-test',
			status: 'pass' as const,
			observedValues: ['203.0.113.10'],
			diagnostic: 'verified',
			observedAt: now,
			createdAt: now,
		};
		const previousEvidenceId = await ctx.db.insert('deliverabilityEvidence', {
			...evidence,
			attemptId: 'gdpr-previous',
		});
		const regressedEvidenceId = await ctx.db.insert('deliverabilityEvidence', {
			...evidence,
			attemptId: 'gdpr-regressed',
			status: 'fail',
		});
		for (let index = 0; index < count; index += 1) {
			const isSent = index === 0;
			const alertId = await ctx.db.insert('deliverabilityRegressionAlerts', {
				organizationId: 'org-x',
				identity: `gdpr-alert-${index}`,
				itemId: 'deployment.ptr',
				targetKey: '5:org-x|deployment',
				previousEvidenceId,
				regressedEvidenceId,
				observedAt: now,
				message: 'PTR regressed',
				emailNotificationState: isSent ? 'sent' : 'pending',
				...(isSent ? { emailNotifiedAt: now } : {}),
				createdAt: now,
			});
			await ctx.db.insert('deliverabilityAlertRecipients', {
				organizationId: 'org-x',
				alertId,
				userId: authUserId,
				status: isSent ? 'sent' : 'pending',
				attemptCount: isSent ? 1 : 0,
				...(isSent ? { sentAt: now } : { nextAttemptAt: now + 60_000 }),
			});
		}
	});
}

type ExportRow = Record<string, unknown>;

async function exportAllUserData(
	t: TestConvex<typeof schema>,
	userId: string,
	onStagedContent?: (url: string) => void
) {
	const manifest = await t.action(api.auth.accountExport.exportUserData, { userId });
	const loadPages = async (
		resource: AccountExportResource,
		options: { organizationId?: string; mailboxId?: Id<'mailboxes'> } = {}
	): Promise<ExportRow[]> => {
		const rows: ExportRow[] = [];
		let cursor: string | undefined;
		for (;;) {
			const result = await t.action(api.auth.accountExport.exportUserDataPage, {
				userId,
				exportSessionId: manifest.exportSessionId as Id<'accountExportSessions'>,
				resource,
				...(cursor ? { cursor } : {}),
				...options,
			});
			for (const rowJson of result.pageJson) {
				const row = JSON.parse(rowJson) as ExportRow;
				const contentDownloadUrl = row['contentDownloadUrl'];
				if (typeof contentDownloadUrl !== 'string') {
					rows.push(row);
					continue;
				}
				onStagedContent?.(contentDownloadUrl);
				const stagedUrl = new URL(contentDownloadUrl);
				const response =
					stagedUrl.origin === EXPORT_TEST_SITE
						? await t.fetch(`${stagedUrl.pathname}${stagedUrl.search}`)
						: await fetch(contentDownloadUrl);
				if (!response.ok) throw new Error('could not load staged export content');
				const {
					['contentDownloadUrl']: _download,
					['contentArtifactId']: _artifact,
					['contentLeaseToken']: _lease,
					...metadata
				} = row;
				rows.push({
					...metadata,
					...((await response.json()) as ExportRow),
				});
			}
			if (result.isDone) return rows;
			cursor = result.continueCursor;
		}
	};
	const memberships = (await loadPages('organizationMemberships')) as Array<
		ExportRow & {
			organizationId: string;
			role: string;
			organization: { _id: string; name: string; slug?: string | null };
		}
	>;
	const organizations = await Promise.all(
		memberships.map(async (membership) => {
			const resourceRows: Array<
				readonly [(typeof ACCOUNT_EXPORT_ORGANIZATION_RESOURCES)[number], ExportRow[]]
			> = [];
			for (const resource of ACCOUNT_EXPORT_ORGANIZATION_RESOURCES) {
				resourceRows.push([
					resource,
					await loadPages(resource, { organizationId: membership.organizationId }),
				]);
			}
			return {
				organization: membership.organization,
				role: membership.role,
				data: Object.fromEntries(resourceRows) as Record<
					(typeof ACCOUNT_EXPORT_ORGANIZATION_RESOURCES)[number],
					ExportRow[]
				>,
			};
		})
	);
	const mailboxes = (await loadPages('mailboxes')) as Array<ExportRow & { _id: Id<'mailboxes'> }>;
	const mailMessages: ExportRow[] = [];
	const mailDrafts: ExportRow[] = [];
	for (const mailbox of mailboxes) {
		mailMessages.push(...(await loadPages('mailMessages', { mailboxId: mailbox._id })));
		mailDrafts.push(...(await loadPages('mailDrafts', { mailboxId: mailbox._id })));
	}
	return {
		...manifest,
		organizations,
		personalData: {
			mailboxes,
			mailMessages,
			mailDrafts,
			externalMailAccounts: await loadPages('externalMailAccounts'),
			chatMessages: await loadPages('chatMessages'),
			deliverabilityAlertRecipientStates: await loadPages('deliverabilityAlertRecipientStates'),
		},
	};
}

// ============================================================
// exportUserData
// ============================================================

describe('accountManagement.exportUserData — requireSelf', () => {
	it('rejects a foreign userId (session is auth-user-1, asks for someone else)', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');

		await expect(
			t.action(api.auth.accountExport.exportUserData, { userId: 'someone-else' })
		).rejects.toThrow();
	});

	it('returns the caller-owned profile + org for their own userId', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'owner@example.com');
		const orgId = await seedOrg(t, 'Acme', 'private organization metadata');
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.userProfile.email).toBe('owner@example.com');
		expect(res.organizations).toHaveLength(1);
		expect(res.organizations[0]!.organization.name).toBe('Acme');
		expect(res.organizations[0]!.organization).toEqual({
			_id: orgId,
			name: 'Acme',
			slug: 'acme',
		});
		expect(res.organizations[0]!.role).toBe('owner');
		expect(typeof res.exportedAt).toBe('number');
		expect(JSON.stringify(res)).not.toContain('private organization metadata');
	});
});

describe('accountManagement.exportUserData — secret redaction', () => {
	it('omits webhook secrets and api-key hashes from the export', async () => {
		const t = newHarness();
		sessionMock.role = 'owner';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'customer@example.com',
				source: 'api',
				doiStatus: 'pending',
				doiConfirmationToken: 'doi-confirmation-capability-canary',
				doiTokenExpiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('campaigns', {
				name: 'Campaign with public archive',
				status: 'sent',
				archiveEnabled: true,
				archiveToken: 'campaign-archive-capability-canary',
				archiveSubject: 'Archive subject',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 'super-secret-signing-key',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'deadbeef-hash-value',
				keyPrefix: 'lm_live_',
				scopes: ['contacts:read'],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		const orgExport = res.organizations[0]!;
		expect(orgExport.data.webhooks).toHaveLength(1);
		expect(orgExport.data.apiKeys).toHaveLength(1);
		expect(orgExport.data.contacts).toHaveLength(1);
		expect(orgExport.data.campaigns).toHaveLength(1);

		// No `secret` on any exported webhook.
		const serialized = JSON.stringify(res);
		expect(serialized).not.toContain('super-secret-signing-key');
		expect(serialized).not.toContain('deadbeef-hash-value');
		expect(serialized).not.toContain('doi-confirmation-capability-canary');
		expect(serialized).not.toContain('campaign-archive-capability-canary');

		expect(orgExport.data.webhooks[0]).not.toHaveProperty('secret');
		expect(orgExport.data.contacts[0]).not.toHaveProperty('doiConfirmationToken');
		expect(orgExport.data.contacts[0]).toHaveProperty('doiTokenExpiresAt');
		expect(orgExport.data.campaigns[0]).not.toHaveProperty('archiveToken');
		expect(orgExport.data.campaigns[0]).toMatchObject({
			archiveEnabled: true,
			archiveSubject: 'Archive subject',
		});
		// api-key export carries only safe metadata (name/prefix/timestamps).
		expect(orgExport.data.apiKeys[0]).not.toHaveProperty('keyHash');
		expect(orgExport.data.apiKeys[0]).toMatchObject({
			name: 'key',
			keyPrefix: 'lm_live_',
		});
	});

	it('exports template content and attachment bytes through fail-closed staged projections', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const { validStorageId, missingStorageId, corruptStorageId } = await t.run(async (ctx) => {
			const now = Date.now();
			const validBytes = new TextEncoder().encode('template attachment bytes');
			const validStorageId = await storeSealedBlob(
				ctx.storage,
				validBytes,
				'application/octet-stream'
			);
			const missingStorageId = await storeSealedBlob(
				ctx.storage,
				new TextEncoder().encode('delete me'),
				'application/octet-stream'
			);
			await ctx.storage.delete(missingStorageId);
			const sealedCorruptSource = await storeSealedBlob(
				ctx.storage,
				new TextEncoder().encode('corrupt me'),
				'application/octet-stream'
			);
			const sealedBlob = await ctx.storage.get(sealedCorruptSource);
			const corruptBytes = new Uint8Array(await sealedBlob!.arrayBuffer());
			corruptBytes[corruptBytes.length - 1] = corruptBytes[corruptBytes.length - 1]! ^ 1;
			const corruptStorageId = await ctx.storage.store(
				new Blob([corruptBytes as unknown as BlobPart])
			);
			await ctx.storage.delete(sealedCorruptSource);
			const personalMailStorageId = await storeSealedBlob(
				ctx.storage,
				new TextEncoder().encode('cross-resource-personal-mail-secret'),
				'text/plain'
			);
			const insertAsset = (storageId: Id<'_storage'>, filename: string) =>
				ctx.db.insert('mediaAssets', {
					storageId,
					filename,
					mimeType: 'application/octet-stream',
					fileSize: validBytes.byteLength,
					url: 'https://capability.invalid/asset',
					uploadedBy: 'auth-user-1',
					createdAt: now,
					updatedAt: now,
				});
			const validAssetId = await insertAsset(validStorageId, 'valid.bin');
			const missingAssetId = await insertAsset(missingStorageId, 'missing.bin');
			const corruptAssetId = await insertAsset(corruptStorageId, 'corrupt.bin');

			await ctx.db.insert('emailTemplates', {
				name: 'Account export template',
				subject: 'Template subject',
				content: JSON.stringify([
					{
						id: 'image-1',
						type: 'image',
						content: {
							alt: 'customer-authored-template-body',
							src: 'https://capability.invalid/image?token=image-url-canary',
							storageId: validStorageId,
							mediaAssetId: validAssetId,
						},
					},
					{
						id: 'cross-resource-image',
						type: 'image',
						content: {
							src: 'https://capability.invalid/personal-mail',
							storageId: personalMailStorageId,
							mediaAssetId: validAssetId,
						},
					},
				]),
				htmlContent: '<img src="https://capability.invalid/html-token-canary">',
				type: 'marketing',
				status: 'draft',
				searchableText: 'future-field-secret-canary',
				seedTag: 'future-seed-secret-canary',
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('transactionalEmails', {
				name: 'Transactional export template',
				slug: 'transactional-export-template',
				subject: 'Transactional subject',
				content: JSON.stringify([{ id: 'text-1', type: 'text', content: { html: 'exact body' } }]),
				htmlContent: '<img src="https://capability.invalid/transactional-html-canary">',
				attachments: JSON.stringify([
					{
						id: 'valid',
						filename: 'valid.bin',
						storageId: validStorageId,
						url: 'https://capability.invalid/attachment-token-canary',
						contentType: 'application/octet-stream',
						fileSize: validBytes.byteLength,
						mediaAssetId: validAssetId,
					},
					{
						id: 'missing',
						filename: 'missing.bin',
						storageId: missingStorageId,
						mediaAssetId: missingAssetId,
						url: 'https://capability.invalid/missing-token-canary',
					},
					{
						id: 'corrupt',
						filename: 'corrupt.bin',
						storageId: corruptStorageId,
						mediaAssetId: corruptAssetId,
						url: 'https://capability.invalid/corrupt-token-canary',
					},
				]),
				status: 'draft',
				searchableText: 'future-transactional-secret-canary',
				seedTag: 'future-transactional-seed-canary',
				createdAt: now,
				updatedAt: now,
			});
			return { validStorageId, missingStorageId, corruptStorageId };
		});

		const exported = await exportAllUserData(t, 'auth-user-1');
		const organizationData = exported.organizations[0]!.data;
		const emailTemplate = organizationData.emailTemplates[0]!;
		const transactionalTemplate = organizationData.transactionalEmails[0]!;

		expect(emailTemplate).toMatchObject({
			name: 'Account export template',
			editorContent: {
				availability: 'available',
				value: [
					{
						content: {
							alt: 'customer-authored-template-body',
							storedContent: {
								contentBase64: btoa('template attachment bytes'),
								contentEncoding: 'base64',
								availability: 'available',
							},
						},
					},
					{
						content: {
							storedContent: {
								contentBase64: '',
								contentEncoding: 'base64',
								availability: 'missing',
							},
						},
					},
				],
			},
		});
		expect(transactionalTemplate).toMatchObject({
			editorContent: {
				availability: 'available',
				value: [{ content: { html: 'exact body' } }],
			},
			attachments: {
				availability: 'available',
				items: [
					{
						id: 'valid',
						filename: 'valid.bin',
						contentBase64: btoa('template attachment bytes'),
						contentEncoding: 'base64',
						availability: 'available',
					},
					{
						id: 'missing',
						filename: 'missing.bin',
						contentBase64: '',
						availability: 'missing',
					},
					{
						id: 'corrupt',
						filename: 'corrupt.bin',
						contentBase64: '',
						availability: 'corrupt',
					},
				],
			},
		});

		for (const row of [emailTemplate, transactionalTemplate]) {
			expect(row).not.toHaveProperty('content');
			expect(row).not.toHaveProperty('htmlContent');
			expect(row).not.toHaveProperty('htmlTranslations');
			expect(row).not.toHaveProperty('searchableText');
			expect(row).not.toHaveProperty('seedTag');
		}
		const serialized = JSON.stringify(exported);
		expect(serialized).not.toContain('cross-resource-personal-mail-secret');
		for (const canary of [
			'image-url-canary',
			'html-token-canary',
			'transactional-html-canary',
			'attachment-token-canary',
			'missing-token-canary',
			'corrupt-token-canary',
			'media-ref-canary',
			'future-field-secret-canary',
			'future-seed-secret-canary',
			'future-transactional-secret-canary',
			'future-transactional-seed-canary',
		]) {
			expect(serialized).not.toContain(canary);
		}
		expect(serialized).not.toContain(String(validStorageId));
		expect(serialized).not.toContain(String(missingStorageId));
		expect(serialized).not.toContain(String(corruptStorageId));
	});
});

describe('accountManagement.exportUserData — soft-deleted contacts', () => {
	it('excludes GDPR-erased (soft-deleted) contacts from the export', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'live@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'erased@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				deletedAt: Date.now(), // soft-deleted / GDPR-erased
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		const emails = res.organizations[0]!.data.contacts.map((contact) => contact['email']);
		expect(emails).toContain('live@example.com');
		expect(emails).not.toContain('erased@example.com');
		expect(res.organizations[0]!.data.contacts).toHaveLength(1);
	});
});

describe('accountExport staging replay and quotas', () => {
	it('reuses one active session and one staged artifact for repeated page cursors', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('emailTemplates', {
				name: 'Replay-safe template',
				subject: 'Replay subject',
				content: JSON.stringify([{ id: 'text', type: 'text', content: { html: 'body' } }]),
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
		});

		const firstManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		const secondManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		expect(secondManifest.exportSessionId).toBe(firstManifest.exportSessionId);

		const pageArgs = {
			userId: 'auth-user-1',
			exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
			resource: 'emailTemplates' as const,
			organizationId: orgId,
		};
		const firstPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const replayedPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const staged = (page: (typeof firstPage)['pageJson']) => {
			const row = JSON.parse(page[0]!) as {
				contentDownloadUrl: string;
				contentArtifactId: Id<'accountExportArtifacts'>;
				contentLeaseToken: string;
			};
			return {
				...row,
				storageId: new URL(row.contentDownloadUrl).searchParams.get('id'),
			};
		};
		const first = staged(firstPage.pageJson);
		const replay = staged(replayedPage.pageJson);
		expect(replay.storageId).toBe(first.storageId);
		expect(replay.contentLeaseToken).not.toBe(first.contentLeaseToken);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: first.contentArtifactId,
				leaseToken: first.contentLeaseToken,
			})
		).resolves.toBe(true);
		const replayUrl = new URL(replay.contentDownloadUrl);
		await expect(t.fetch(`${replayUrl.pathname}${replayUrl.search}`)).resolves.toMatchObject({
			ok: true,
		});

		const ledger = await t.run(async (ctx) => ({
			sessions: await ctx.db.query('accountExportSessions').collect(),
			artifacts: await ctx.db.query('accountExportArtifacts').collect(),
			leases: await ctx.db.query('accountExportArtifactLeases').collect(),
		}));
		expect(ledger.sessions).toHaveLength(1);
		expect(ledger.artifacts).toHaveLength(1);
		expect(ledger.leases).toHaveLength(1);
		expect(ledger.sessions[0]).toMatchObject({
			artifactCount: 1,
			artifactBytes: ledger.artifacts[0]!.contentLength,
		});

		vi.stubEnv('INSTANCE_SECRET', undefined);
		await expect(t.action(api.auth.accountExport.exportUserDataPage, pageArgs)).rejects.toThrow(
			'Could not create account export artifact URL'
		);
		await expect(
			t.run(async (ctx) => ({
				artifacts: await ctx.db.query('accountExportArtifacts').collect(),
				leases: await ctx.db.query('accountExportArtifactLeases').collect(),
			}))
		).resolves.toMatchObject({
			artifacts: [expect.objectContaining({ activeLeaseCount: 1 })],
			leases: [expect.objectContaining({ leaseToken: replay.contentLeaseToken })],
		});
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: replay.contentArtifactId,
				leaseToken: 'wrong-token',
			})
		).resolves.toBe(false);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: replay.contentArtifactId,
				leaseToken: replay.contentLeaseToken,
			})
		).resolves.toBe(true);
		await expect(
			t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
				artifactId: replay.contentArtifactId,
				leaseToken: replay.contentLeaseToken,
			})
		).resolves.toBe(false);
		await expect(
			t.run(async (ctx) => ({
				artifact: await ctx.db.get(replay.contentArtifactId),
				leases: await ctx.db.query('accountExportArtifactLeases').collect(),
				blob: await ctx.storage.get(replay.storageId as Id<'_storage'>),
			}))
		).resolves.toEqual({ artifact: null, leases: [], blob: null });
	});

	it('stages fresh content when a row changes during a reused session', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		const templateId = await t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert('emailTemplates', {
				name: 'Mutable template',
				subject: 'Mutable subject',
				content: JSON.stringify([{ id: 'text', type: 'text', content: { html: 'first' } }]),
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
		});

		const firstManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		const pageArgs = {
			userId: 'auth-user-1',
			exportSessionId: firstManifest.exportSessionId as Id<'accountExportSessions'>,
			resource: 'emailTemplates' as const,
			organizationId: orgId,
		};
		const firstPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		await t.run(async (ctx) => {
			await ctx.db.patch(templateId, {
				content: JSON.stringify([{ id: 'text', type: 'text', content: { html: 'second' } }]),
				updatedAt: Date.now() + 1,
			});
		});
		const secondManifest = await t.action(api.auth.accountExport.exportUserData, {
			userId: 'auth-user-1',
		});
		expect(secondManifest.exportSessionId).toBe(firstManifest.exportSessionId);
		const secondPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);

		const stagedContent = async (page: (typeof firstPage)['pageJson']) => {
			const row = JSON.parse(page[0]!) as { contentDownloadUrl: string };
			const stagedUrl = new URL(row.contentDownloadUrl);
			const response = await t.fetch(`${stagedUrl.pathname}${stagedUrl.search}`);
			expect(response.ok).toBe(true);
			return {
				storageId: stagedUrl.searchParams.get('id'),
				content: await response.json(),
			};
		};
		const firstContent = await stagedContent(firstPage.pageJson);
		const secondContent = await stagedContent(secondPage.pageJson);
		expect(firstContent.storageId).not.toBe(secondContent.storageId);
		expect(firstContent.content).toMatchObject({
			editorContent: {
				availability: 'available',
				value: [{ content: { html: 'first' } }],
			},
		});
		expect(secondContent.content).toMatchObject({
			editorContent: {
				availability: 'available',
				value: [{ content: { html: 'second' } }],
			},
		});
		const artifacts = await t.run(async (ctx) => ctx.db.query('accountExportArtifacts').collect());
		expect(artifacts).toHaveLength(2);
	});

	it('fails explicitly without registering another artifact when the session quota is full', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		const sessionId = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('emailTemplates', {
				name: 'Quota template',
				subject: 'Quota subject',
				content: '[]',
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
			return ctx.db.insert('accountExportSessions', {
				userId: 'auth-user-1',
				artifactCount: 5_000,
				artifactBytes: 0,
				createdAt: now,
				expiresAt: now + 60_000,
			});
		});

		await expect(
			t.action(api.auth.accountExport.exportUserDataPage, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				resource: 'emailTemplates',
				organizationId: orgId,
			})
		).rejects.toThrow('Account export staging quota exceeded');
		const artifacts = await t.run(async (ctx) => ctx.db.query('accountExportArtifacts').collect());
		expect(artifacts).toHaveLength(0);
	});

	it('releases streamed artifacts so one session can stage beyond its in-flight cap', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');
		const initialExpiry = Date.now() + 60_000;
		const sessionId = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('emailTemplates', {
				name: 'In-flight quota template',
				subject: 'Quota subject',
				content: '[]',
				type: 'marketing',
				status: 'draft',
				createdAt: now,
				updatedAt: now,
			});
			return ctx.db.insert('accountExportSessions', {
				userId: 'auth-user-1',
				artifactCount: 4_999,
				artifactBytes: 0,
				createdAt: now,
				expiresAt: initialExpiry,
			});
		});
		const pageArgs = {
			userId: 'auth-user-1',
			exportSessionId: sessionId,
			resource: 'emailTemplates' as const,
			organizationId: orgId,
		};
		const stagedArtifact = (pageJson: string[]) => {
			const row = JSON.parse(pageJson[0]!) as {
				contentArtifactId: Id<'accountExportArtifacts'>;
				contentDownloadUrl: string;
				contentLeaseToken: string;
			};
			return {
				artifactId: row.contentArtifactId,
				storageId: new URL(row.contentDownloadUrl).searchParams.get('id'),
				leaseToken: row.contentLeaseToken,
			};
		};

		const firstPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const first = stagedArtifact(firstPage.pageJson);
		expect(
			await t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				artifactId: first.artifactId,
				leaseToken: first.leaseToken,
			})
		).toBe(true);

		const secondPage = await t.action(api.auth.accountExport.exportUserDataPage, pageArgs);
		const second = stagedArtifact(secondPage.pageJson);
		expect(second.storageId).not.toBe(first.storageId);
		const ledger = await t.run(async (ctx) => ({
			session: await ctx.db.get(sessionId),
			artifacts: await ctx.db.query('accountExportArtifacts').collect(),
		}));
		expect(ledger.session).toMatchObject({ artifactCount: 5_000 });
		expect(ledger.session!.expiresAt).toBeGreaterThan(initialExpiry + 30 * 60_000);
		expect(ledger.artifacts).toHaveLength(1);

		expect(
			await t.action(api.auth.accountExport.acknowledgeExportArtifact, {
				userId: 'auth-user-1',
				exportSessionId: sessionId,
				artifactId: second.artifactId,
				leaseToken: second.leaseToken,
			})
		).toBe(true);
		expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toMatchObject({
			artifactCount: 4_999,
			artifactBytes: 0,
		});
	});
});

describe('accountManagement.exportUserData — admin-only metadata gating', () => {
	it('populates api-key + webhook metadata for an org admin/owner', async () => {
		const t = newHarness();
		sessionMock.role = 'admin';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		// Membership role drives the in-handler hasPermission gate.
		await seedMember(t, orgId, 'auth-user-1', 'admin');

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 's',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'h',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.organizations[0]!.data.apiKeys).toHaveLength(1);
		expect(res.organizations[0]!.data.webhooks).toHaveLength(1);
	});

	it('leaves api-key + webhook metadata EMPTY for a plain editor', async () => {
		const t = newHarness();
		sessionMock.role = 'editor';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		// The handler reads the *membership* role (not the session) for the gate.
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'customer@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('blockedEmails', {
				email: 'blocked-customer@example.com',
				reason: 'manual',
				createdAt: Date.now(),
			});
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 's',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'h',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		// Editor self-export can't enumerate key prefixes / webhook endpoints.
		expect(res.organizations[0]!.data.apiKeys).toHaveLength(0);
		expect(res.organizations[0]!.data.webhooks).toHaveLength(0);
		expect(res.organizations[0]!.data.contacts).toHaveLength(0);
		expect(Object.values(res.organizations[0]!.data).every((rows) => rows.length === 0)).toBe(true);
		expect(JSON.stringify(res)).not.toContain('customer@example.com');
		expect(JSON.stringify(res)).not.toContain('blocked-customer@example.com');
	});
});

describe('accountManagement.exportUserData — personal data (right-to-access mirror)', () => {
	it("includes the caller's own mailbox, mail, drafts, external account and chat, with secrets/blob handles redacted", async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'me@example.com');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');
		await seedDeliverabilityAlertRecipients(t, 'auth-user-1', 1);

		await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				address: 'me@example.com',
				domain: 'example.com',
				status: 'suspended' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('mailboxes', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				address: 'team@example.com',
				domain: 'example.com',
				scope: 'shared',
				status: 'active',
				usedBytes: 0,
				uidValidity: now + 1,
				createdAt: now,
				updatedAt: now,
			});
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				role: 'inbox' as const,
				uidValidity: now,
				uidNext: 2,
				highestModseq: 1,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['me@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'a@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const encoder = new TextEncoder();
			const rawStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('raw eml bytes'),
				'message/rfc822'
			);
			const textBodyStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('storage-backed text body'),
				'text/plain'
			);
			const htmlBodyStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('<p>storage-backed html body</p>'),
				'text/html'
			);
			const missingStorageId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('deleted before export'),
				'text/plain'
			);
			await ctx.storage.delete(missingStorageId);
			const validBeforeTamperingId = await storeSealedBlob(
				ctx.storage,
				encoder.encode('tamper this ciphertext'),
				'text/html'
			);
			const validBeforeTampering = await ctx.storage.get(validBeforeTamperingId);
			const tamperedBytes = new Uint8Array(await validBeforeTampering!.arrayBuffer());
			const finalByteIndex = tamperedBytes.length - 1;
			tamperedBytes[finalByteIndex] = tamperedBytes[finalByteIndex]! ^ 1;
			const corruptStorageId = await ctx.storage.store(
				new Blob([tamperedBytes as unknown as BlobPart], { type: 'text/html' })
			);
			await ctx.storage.delete(validBeforeTamperingId);
			const corruptInlineBody = tamperSealedTextBody(
				await sealBodyAtWrite('tamper this inline body')
			);
			const messageFields = {
				mailboxId,
				folderId,
				modseq: 1,
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['me@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				normalizedSubject: 'personal subject',
				snippet: 'personal body snippet',
				rawSize: 13,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			};
			await ctx.db.insert('mailMessages', {
				...messageFields,
				uid: 1,
				rfc822MessageId: '<m1@example.com>',
				subject: 'personal subject',
				rawStorageId,
				textBodyStorageId,
				htmlBodyStorageId,
			});
			await ctx.db.insert('mailMessages', {
				...messageFields,
				uid: 2,
				rfc822MessageId: '<m2@example.com>',
				subject: 'partially unavailable message',
				rawStorageId: missingStorageId,
				textBodyStorageId: corruptStorageId,
				htmlBodyInline: corruptInlineBody,
			});
			const draftAttachmentStorageId = await ctx.storage.store(
				new Blob(['draft attachment bytes'], { type: 'text/plain' })
			);
			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['draft-recipient@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: 'draft subject',
				bodyHtml: await sealBodyAtWrite('<p>draft body</p>'),
				bodyText: await sealBodyAtWrite('draft text body'),
				attachments: [
					{
						storageId: draftAttachmentStorageId,
						filename: 'notes.txt',
						contentType: 'text/plain',
						size: 22,
						isInline: false,
					},
				],
				state: 'draft' as const,
				lastEditedAt: now,
				createdAt: now,
			});
			await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['draft-recipient@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@example.com',
				subject: 'corrupt draft',
				bodyHtml: corruptInlineBody,
				attachments: [],
				state: 'draft' as const,
				lastEditedAt: now + 1,
				createdAt: now,
			});
			await ctx.db.insert('externalMailAccounts', {
				userId: 'auth-user-1',
				organizationId: 'org-x',
				mailboxId,
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'me@example.com',
				secretCiphertext: 'super-secret-ciphertext',
				secretIv: 'super-secret-iv',
				secretAuthTag: 'super-secret-tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: 'auth-user-1',
				lastMessageAt: now,
				messageCount: 2,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'auth-user-1',
				text: 'my chat message',
				createdAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'not my message',
				createdAt: now,
			});
		});

		const stagedContentUrls: string[] = [];
		const res = await exportAllUserData(t, 'auth-user-1', (url) => stagedContentUrls.push(url));

		// Personal sections are populated for the caller's own data.
		expect(res.personalData.mailboxes).toHaveLength(1);
		expect(res.personalData.mailboxes[0]!['status']).toBe('suspended');
		expect(res.personalData.mailMessages).toHaveLength(2);
		const completeMessage = res.personalData.mailMessages.find(
			(message) => message['subject'] === 'personal subject'
		);
		expect(completeMessage).toMatchObject({
			rawMessage: btoa('raw eml bytes'),
			rawMessageEncoding: 'base64',
			textBody: 'storage-backed text body',
			htmlBody: '<p>storage-backed html body</p>',
			bodyAvailability: { raw: 'available', text: 'available', html: 'available' },
		});
		const partialMessage = res.personalData.mailMessages.find(
			(message) => message['subject'] === 'partially unavailable message'
		);
		expect(partialMessage).toMatchObject({
			rawMessage: '',
			rawMessageEncoding: 'base64',
			textBody: '',
			htmlBody: '',
			bodyAvailability: { raw: 'missing', text: 'corrupt', html: 'corrupt' },
		});
		expect(res.personalData.mailDrafts).toHaveLength(2);
		const completeDraft = res.personalData.mailDrafts.find(
			(draft) => draft['subject'] === 'draft subject'
		);
		expect(completeDraft).toMatchObject({
			bodyHtml: '<p>draft body</p>',
			bodyText: 'draft text body',
			bodyAvailability: { html: 'available', text: 'available', blocks: 'missing' },
			attachments: [
				{
					filename: 'notes.txt',
					contentBase64: btoa('draft attachment bytes'),
					isContentAvailable: true,
				},
			],
		});
		const corruptDraft = res.personalData.mailDrafts.find(
			(draft) => draft['subject'] === 'corrupt draft'
		);
		expect(corruptDraft).toMatchObject({
			bodyHtml: '',
			bodyAvailability: { html: 'corrupt', text: 'missing', blocks: 'missing' },
			attachments: [],
		});
		expect(res.personalData.externalMailAccounts).toHaveLength(1);

		// Chat: only the caller's own authorship is exported, not others'.
		expect(res.personalData.chatMessages).toHaveLength(1);
		expect(res.personalData.chatMessages[0]!['text']).toBe('my chat message');
		expect(res.personalData.deliverabilityAlertRecipientStates).toHaveLength(1);
		expect(res.personalData.deliverabilityAlertRecipientStates[0]!['state']).toMatchObject({
			userId: 'auth-user-1',
			status: 'sent',
			attemptCount: 1,
		});
		expect(res.personalData.deliverabilityAlertRecipientStates[0]!['state']).not.toHaveProperty(
			'email'
		);

		// Redaction: storage-blob handles and the encrypted credential envelope
		// never appear in the bundle.
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('rawStorageId');
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('textBodyStorageId');
		expect(res.personalData.mailMessages[0]).not.toHaveProperty('htmlBodyStorageId');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretCiphertext');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretIv');
		expect(res.personalData.externalMailAccounts[0]).not.toHaveProperty('secretAuthTag');

		const serialized = JSON.stringify(res);
		expect(serialized).not.toContain('super-secret-ciphertext');
		expect(serialized).not.toContain('super-secret-iv');
		expect(serialized).not.toContain('super-secret-tag');

		expect(stagedContentUrls).toHaveLength(4);
		for (const contentUrl of stagedContentUrls) {
			const storageId = new URL(contentUrl).searchParams.get('id') as Id<'_storage'> | null;
			expect(storageId).not.toBeNull();
			const storedBytes = new Uint8Array(
				await t.run(async (ctx) => {
					const blob = await ctx.storage.get(storageId!);
					return await blob!.arrayBuffer();
				})
			);
			expect(isSealedBytesAtRest(storedBytes)).toBe(true);
			const storedText = new TextDecoder().decode(storedBytes);
			expect(storedText).not.toContain('raw eml bytes');
			expect(storedText).not.toContain('draft attachment bytes');
		}
	});

	it('returns empty personal-data sections when the caller owns no mail or chat', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.personalData.mailboxes).toHaveLength(0);
		expect(res.personalData.mailMessages).toHaveLength(0);
		expect(res.personalData.mailDrafts).toHaveLength(0);
		expect(res.personalData.externalMailAccounts).toHaveLength(0);
		expect(res.personalData.chatMessages).toHaveLength(0);
		expect(res.personalData.deliverabilityAlertRecipientStates).toHaveLength(0);
	});

	it('paginates recipient history beyond one export page without truncation', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		await seedDeliverabilityAlertRecipients(t, 'auth-user-1', 101);

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.personalData.deliverabilityAlertRecipientStates).toHaveLength(101);
	});
});

// ============================================================
// account-deletion path — non-owner member
// ============================================================

describe('accountManagement.deleteAccountForRequest — non-owner member', () => {
	it('erases auth-side rows + onboarding + profile and hands off member erasure', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		// Onboarding row keyed by BetterAuth userId.
		await t.run(async (ctx) => {
			await ctx.db.insert('onboardingProgress', {
				userId: 'auth-user-1',
				dismissed: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				// Past its grace period so the cron picks it up.
				scheduledForDeletion: Date.now() - 1000,
				cancellationToken: 'tok',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		// Drive the real cron entry point (a proper mutation that wraps
		// deleteAccountForRequest in a transaction + schedules erasure).
		const result = await t.mutation(internal.auth.accountDeletion.processPendingDeletions, {});
		expect(result.processedCount).toBe(1);

		await t.run(async (ctx) => {
			// Profile + onboarding gone.
			expect(await ctx.db.get(profileId)).toBeNull();
			const onboarding = await ctx.db
				.query('onboardingProgress')
				.withIndex('by_user', (q) => q.eq('userId', 'auth-user-1'))
				.collect();
			expect(onboarding).toHaveLength(0);
		});

		// BetterAuth membership row was deleted.
		const remainingMembers = (await t.query(components.betterAuth.adapter.findMany, {
			model: 'member',
			where: [{ field: 'userId', value: 'auth-user-1' }],
			paginationOpts: { cursor: null, numItems: 100 },
		} as never)) as { page: unknown[] };
		expect(remainingMembers.page).toHaveLength(0);

		// Request is NOT yet completed: the batched member-erasure walk owns that
		// transition (it was scheduled, not run inline). Still pending here.
		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('pending');
		});

		// Run the member-erasure walk the cron handed off to. This member owns no
		// personal data, so it terminates in one hop, marking the request done.
		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId: 'auth-user-1',
			requestId,
		});
		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId: 'auth-user-1',
			requestId,
			isAlertErasureDone: true,
			isAlertReceiptErasureDone: true,
		});
		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});
});

// ============================================================
// member-erasure batched walk (auth/memberErasure.ts)
// ============================================================

describe('memberErasure.eraseMemberData', () => {
	/** Drive the self-rescheduling walk to completion deterministically. */
	async function drainWalk(
		t: TestConvex<typeof schema>,
		authUserId: string,
		requestId: Id<'accountDeletionRequests'>
	): Promise<void> {
		// Bounded loop — every hop either deletes a batch (and reschedules) or
		// reaches phase 4. A handful of hops covers the seeded data.
		for (let i = 0; i < 20; i++) {
			const erasureState = await t.run(async (ctx) => {
				const recipient = await ctx.db
					.query('deliverabilityAlertRecipients')
					.withIndex('by_user', (q) => q.eq('userId', authUserId))
					.first();
				const receipt = await ctx.db
					.query('deliverabilityAlertRecipientReceipts')
					.withIndex('by_user', (q) => q.eq('userId', authUserId))
					.first();
				return {
					isAlertErasureDone: recipient === null,
					isAlertReceiptErasureDone: receipt === null,
				};
			});
			await t.mutation(internal.auth.memberErasure.eraseMemberData, {
				authUserId,
				requestId,
				...(erasureState.isAlertErasureDone ? { isAlertErasureDone: true } : {}),
				...(erasureState.isAlertReceiptErasureDone ? { isAlertReceiptErasureDone: true } : {}),
			});
			const done = await t.run(async (ctx) => {
				const r = await ctx.db.get(requestId);
				return r?.status === 'completed';
			});
			if (done) return;
		}
		throw new Error('member-erasure walk did not terminate within hop budget');
	}

	it('erases the mailbox + app passwords, external creds, chat authorship and completes the request', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-2';
		const profileId = await seedProfile(t, authUserId, 'member@example.com');

		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'member@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok2',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		// Seed the personal mailbox (+ one message with real storage blobs), an
		// app password keyed to the mailbox, an external IMAP account with a
		// folder-sync row, a user-keyed app password, and chat authorship — both
		// the member's own messages and another author's.
		const { mailboxId, otherAuthorMessageId } = await t.run(async (ctx) => {
			const now = Date.now();
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: authUserId,
				organizationId: 'org-x',
				address: 'member@example.com',
				domain: 'example.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});

			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: 'INBOX',
				role: 'inbox' as const,
				uidValidity: now,
				uidNext: 2,
				highestModseq: 1,
				totalCount: 1,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: 'hi',
				participants: ['member@example.com'],
				messageCount: 1,
				unreadCount: 0,
				hasFlagged: false,
				hasAttachments: false,
				lastMessageAt: now,
				firstMessageAt: now,
				latestSnippet: 'hi',
				latestFromAddress: 'a@example.com',
				latestSubject: 'hi',
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw eml bytes']));
			await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: 1,
				modseq: 1,
				rfc822MessageId: '<m1@example.com>',
				threadId,
				fromAddress: 'a@example.com',
				toAddresses: ['member@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'hi',
				normalizedSubject: 'hi',
				snippet: 'hi',
				rawStorageId,
				rawSize: 13,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: now,
				internalDate: now,
				createdAt: now,
				updatedAt: now,
			});

			// App password keyed to the mailbox.
			await ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: authUserId,
				label: 'iPhone',
				passwordHash: 'salt:hash',
				passwordPrefix: 'abcd',
				scopes: ['imap' as const],
				createdAt: now,
			});

			// External IMAP account + folder-sync row.
			const accountId = await ctx.db.insert('externalMailAccounts', {
				userId: authUserId,
				organizationId: 'org-x',
				mailboxId,
				imapHost: 'imap.example.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example.com',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: 'member@example.com',
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('externalMailFolderSync', {
				accountId,
				mailboxId,
				folderId,
				remoteName: 'INBOX',
				remoteUidValidity: 1,
				lastSeenUid: 0,
				lastSyncedAt: now,
			});

			// Chat: a room with the member's own message + another author's.
			const roomId = await ctx.db.insert('chatRooms', {
				kind: 'channel' as const,
				name: 'general',
				normalizedName: 'general',
				visibility: 'public' as const,
				createdBy: authUserId,
				lastMessageAt: now,
				messageCount: 2,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('chatMessages', {
				roomId,
				authorId: authUserId,
				text: 'mine',
				createdAt: now,
			});
			const otherAuthorMessageId = await ctx.db.insert('chatMessages', {
				roomId,
				authorId: 'someone-else',
				text: 'theirs',
				createdAt: now,
			});
			await ctx.db.insert('chatRoomMembers', {
				roomId,
				memberId: authUserId,
				role: 'member' as const,
				joinedAt: now,
				lastReadAt: now,
			});

			return { mailboxId, otherAuthorMessageId };
		});

		await drainWalk(t, authUserId, requestId);

		await t.run(async (ctx) => {
			// Mailbox + its message gone.
			expect(await ctx.db.get(mailboxId)).toBeNull();
			const messages = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			expect(messages).toHaveLength(0);

			// App passwords (mailbox- and user-keyed) gone.
			const appPasswords = await ctx.db
				.query('mailAppPasswords')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(appPasswords).toHaveLength(0);

			// External credentials + sync rows gone.
			const externalAccounts = await ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(externalAccounts).toHaveLength(0);

			// Chat: the member's authorship is anonymized; others are untouched.
			const authored = await ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', authUserId))
				.collect();
			expect(authored).toHaveLength(0);
			const anonymized = await ctx.db
				.query('chatMessages')
				.withIndex('by_author', (q) => q.eq('authorId', '[deleted account]'))
				.collect();
			expect(anonymized).toHaveLength(1);
			expect(anonymized[0]!.text).toBe('mine');

			// Another author's message is unchanged.
			const other = await ctx.db.get(otherAuthorMessageId);
			expect(other?.authorId).toBe('someone-else');

			// Room membership dropped.
			const memberships = await ctx.db
				.query('chatRoomMembers')
				.withIndex('by_member', (q) => q.eq('memberId', authUserId))
				.collect();
			expect(memberships).toHaveLength(0);

			// Request marked completed — the walk terminated.
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});

	it('anonymizes more than one recipient-ledger page and reconciles each parent alert', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-with-alerts';
		const profileId = await seedProfile(t, authUserId);
		const requestId = await t.run((ctx) =>
			ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'alerts@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'alert-ledger-token',
				status: 'pending',
				createdAt: Date.now(),
			})
		);
		await seedDeliverabilityAlertRecipients(t, authUserId, 101);

		await drainWalk(t, authUserId, requestId);

		await t.run(async (ctx) => {
			const ownedRows = await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', authUserId))
				.collect();
			expect(ownedRows).toHaveLength(0);
			const anonymizedRows = await ctx.db
				.query('deliverabilityAlertRecipients')
				.withIndex('by_user', (q) => q.eq('userId', '[deleted account]'))
				.collect();
			expect(anonymizedRows).toHaveLength(101);
			expect(anonymizedRows.filter((row) => row.status === 'sent')).toHaveLength(1);
			expect(anonymizedRows.filter((row) => row.status === 'cancelled')).toHaveLength(100);

			const alerts = await ctx.db.query('deliverabilityRegressionAlerts').collect();
			expect(alerts.filter((alert) => alert.emailNotificationState === 'sent')).toHaveLength(1);
			expect(alerts.filter((alert) => alert.emailNotificationState === 'unavailable')).toHaveLength(
				100
			);
			expect(
				alerts
					.filter((alert) => alert.emailNotificationState === 'unavailable')
					.every((alert) => alert.emailNotifiedAt === undefined)
			).toBe(true);
		});
	});

	it('is a clean no-op (still completes the request) when the member owns no personal data', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-3';
		const profileId = await seedProfile(t, authUserId);
		const requestId = await t.run(async (ctx) => {
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'me@example.com',
				requestedAt: Date.now(),
				scheduledForDeletion: Date.now(),
				cancellationToken: 'tok3',
				status: 'pending',
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.auth.memberErasure.eraseMemberData, {
			authUserId,
			requestId,
			isAlertErasureDone: true,
			isAlertReceiptErasureDone: true,
		});

		await t.run(async (ctx) => {
			const request = await ctx.db.get(requestId);
			expect(request?.status).toBe('completed');
		});
	});

	it('purges staged export leases, artifacts, and blobs in bounded member-erasure hops', async () => {
		const t = newHarness();
		const authUserId = 'auth-user-export-staging';
		const profileId = await seedProfile(t, authUserId);
		const { requestId, storageIds } = await t.run(async (ctx) => {
			const now = Date.now();
			const requestId = await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profileId,
				email: 'staging@example.com',
				requestedAt: now,
				scheduledForDeletion: now,
				cancellationToken: 'staging-token',
				status: 'pending',
				createdAt: now,
			});
			const sessionId = await ctx.db.insert('accountExportSessions', {
				userId: authUserId,
				artifactCount: 26,
				artifactBytes: 26,
				leaseCount: 26,
				createdAt: now,
				expiresAt: now + 60_000,
			});
			const storageIds: Id<'_storage'>[] = [];
			for (let index = 0; index < 26; index += 1) {
				const storageId = await ctx.storage.store(new Blob([new Uint8Array([index])]));
				storageIds.push(storageId);
				const artifactId = await ctx.db.insert('accountExportArtifacts', {
					sessionId,
					artifactKey: `artifact-${index}`,
					storageId,
					contentLength: 1,
					activeLeaseCount: 1,
					createdAt: now,
				});
				await ctx.db.insert('accountExportArtifactLeases', {
					sessionId,
					artifactId,
					leaseToken: `lease-${index}`,
					createdAt: now,
				});
			}
			return { requestId, storageIds };
		});

		await drainWalk(t, authUserId, requestId);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('accountExportSessions').collect()).toHaveLength(0);
			expect(await ctx.db.query('accountExportArtifacts').collect()).toHaveLength(0);
			expect(await ctx.db.query('accountExportArtifactLeases').collect()).toHaveLength(0);
			for (const storageId of storageIds) expect(await ctx.storage.get(storageId)).toBeNull();
		});
	});
});
