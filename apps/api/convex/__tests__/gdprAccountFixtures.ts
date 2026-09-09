/**
 * Shared harness + seed helpers for the GDPR account suites
 * (gdprAccount*.integration.test.ts): a convex-test runner with the BetterAuth
 * component registered, BetterAuth organization/member rows seeded through the
 * adapter mutation, and the paged export drained into one document.
 *
 * The session mock these suites rely on lives in gdprSessionMock.ts so the
 * `vi.mock` factory stays import-light.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { ACCOUNT_EXPORT_ORGANIZATION_RESOURCES, type AccountExportResource } from '@owlat/shared';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { api, components } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

export const EXPORT_TEST_SECRET = 'gdpr-export-test-instance-secret-for-sealed-artifacts';
export const EXPORT_TEST_SITE = 'https://gdpr-export-test.convex.site';

export function tamperSealedTextBody(sealed: string): string {
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

export const allModules = import.meta.glob('../**/*.*s');
export const modules = Object.fromEntries(
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

export const betterAuthModules = import.meta.glob('../betterAuth/**/*.*s');

export function newHarness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	rateLimiterTest.register(t);
	return t;
}

export async function seedProfile(
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
export async function seedOrg(
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
export async function seedMember(
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

export async function seedDeliverabilityAlertRecipients(
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

export async function exportAllUserData(
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
