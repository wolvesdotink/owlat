/**
 * Organization deletion step (module) — interface + shared helpers.
 *
 * Each step module owns one deletable table. Per-module unit-testable;
 * the **Organization deletion walker** in `../walker.ts` owns the loop
 * (batch repeats vs next-step advance) and the typed dispatch.
 *
 * See docs/adr/0025-organization-deletion-module-family.md.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../../../_generated/server';

/**
 * Typed literal union of every table the wipe walks. The walker's
 * `runStep` validator is built off this union — a typo (e.g.
 * `'campaign'` vs `'campaigns'`) is a compile error, not a silent
 * runtime no-op. Closes drift #5 from ADR-0025.
 *
 * The list is intentionally exhaustive across the schema. Any new
 * `defineTable(...)` in `convex/schema/*` that holds per-organization
 * data must add a literal here and a sibling step module.
 */
export type OrganizationDeletionTable =
	| 'mediaAssets'
	| 'semanticFileContacts'
	| 'semanticFiles'
	| 'mailMessages'
	| 'mailDrafts'
	| 'transactionalSends'
	| 'emailSends'
	| 'agentActions'
	| 'contentScanResults'
	| 'inboundMessages'
	| 'conversationThreads'
	| 'mailAliases'
	| 'mailFolders'
	| 'mailLabels'
	| 'mailVoiceProfiles'
	| 'mailFilters'
	| 'mailSignatures'
	| 'mailSnippets'
	| 'mailUserSettings'
	| 'mailAppPasswords'
	| 'mailboxes'
	| 'webhookDeliveryLogs'
	| 'webhooks'
	| 'formSubmissions'
	| 'formEndpoints'
	| 'automationStepRuns'
	| 'automationRuns'
	| 'automationSteps'
	| 'automations'
	| 'campaigns'
	| 'emailTemplates'
	| 'transactionalEmails'
	| 'emailBlocks'
	| 'contacts'
	| 'contactProperties'
	| 'topics'
	| 'segments'
	| 'apiKeys'
	| 'blockedEmails'
	| 'knowledgeEntries'
	| 'knowledgeEntryContacts'
	| 'sendingDomainMtaIdentities'
	| 'sendingDomainSesIdentities'
	| 'trackingDomains'
	| 'sendingReputation'
	| 'providerHealth'
	| 'providerRoutes'
	| 'domains'
	| 'onboardingProgress'
	| 'auditLogs'
	| 'instanceSettings'
	| 'unifiedMessages'
	| 'channelConfigs'
	| 'agentMetrics'
	| 'llmUsageEvents'
	| 'agentCircuitBreakers'
	| 'agentConfig'
	| 'autonomyFeedback'
	| 'autonomyRules'
	| 'autonomySuggestions'
	| 'mailThreads'
	| 'mailContacts'
	| 'mailSenderCategoryOverrides'
	| 'mailForwarding'
	| 'mailVacationResponders'
	| 'mailVacationLog'
	| 'mailAuditLog'
	| 'mailAuthFailures'
	| 'mailboxMigrations'
	| 'externalMailFolderSync'
	| 'externalMailAccounts'
	| 'pendingMailboxes'
	| 'webhookPayloads'
	| 'automationStatShards'
	| 'campaignSendJobs'
	| 'campaignStatShards'
	| 'sendDailyStats'
	| 'contactTopics'
	| 'contactPropertyValues'
	| 'contactActivities'
	| 'contactIdentities'
	| 'contactRelationships'
	| 'knowledgeRelations'
	| 'knowledgeBackfillJobs'
	| 'knowledgeEdgeBackfillJobs'
	| 'knowledgeGraphStats'
	| 'chatMentions'
	| 'chatMessages'
	| 'chatRoomMembers'
	| 'chatRooms'
	| 'aiMessages'
	| 'aiConversations'
	| 'coalesceBatches'
	| 'visualizations'
	| 'dashboardLayouts'
	| 'shareLinks'
	| 'integrationImports'
	| 'codeWorkTasks';

import { TENANT_TABLES } from '../../../lib/tenantTables';

/**
 * Compile-time guard: every table classified as tenant data MUST have an
 * organization-deletion step. Before this guard, 41 tenant tables — including
 * externalMailAccounts (encrypted IMAP/SMTP credentials) — silently survived
 * 'Delete organization'. Adding a table to TENANT_TABLES without extending
 * the union above (and the walker's STEPS/registry) is now a compile error.
 */
type TenantTableMissingFromWipe = Exclude<
	(typeof TENANT_TABLES)[number],
	OrganizationDeletionTable
>;
type AssertWipeCoversTenantData<_T extends never> = true;
export type _WipeCoversAllTenantTables = AssertWipeCoversTenantData<TenantTableMissingFromWipe>;

export const organizationDeletionTableValidator = v.union(
	v.literal('mediaAssets'),
	v.literal('semanticFileContacts'),
	v.literal('semanticFiles'),
	v.literal('mailMessages'),
	v.literal('mailDrafts'),
	v.literal('transactionalSends'),
	v.literal('emailSends'),
	v.literal('agentActions'),
	v.literal('contentScanResults'),
	v.literal('inboundMessages'),
	v.literal('conversationThreads'),
	v.literal('mailAliases'),
	v.literal('mailFolders'),
	v.literal('mailLabels'),
	v.literal('mailVoiceProfiles'),
	v.literal('mailFilters'),
	v.literal('mailSignatures'),
	v.literal('mailSnippets'),
	v.literal('mailUserSettings'),
	v.literal('mailAppPasswords'),
	v.literal('mailboxes'),
	v.literal('webhookDeliveryLogs'),
	v.literal('webhooks'),
	v.literal('formSubmissions'),
	v.literal('formEndpoints'),
	v.literal('automationStepRuns'),
	v.literal('automationRuns'),
	v.literal('automationSteps'),
	v.literal('automations'),
	v.literal('campaigns'),
	v.literal('emailTemplates'),
	v.literal('transactionalEmails'),
	v.literal('emailBlocks'),
	v.literal('contacts'),
	v.literal('contactProperties'),
	v.literal('topics'),
	v.literal('segments'),
	v.literal('apiKeys'),
	v.literal('blockedEmails'),
	v.literal('knowledgeEntries'),
	v.literal('knowledgeEntryContacts'),
	v.literal('sendingDomainMtaIdentities'),
	v.literal('sendingDomainSesIdentities'),
	v.literal('trackingDomains'),
	v.literal('sendingReputation'),
	v.literal('providerHealth'),
	v.literal('providerRoutes'),
	v.literal('domains'),
	v.literal('onboardingProgress'),
	v.literal('auditLogs'),
	v.literal('instanceSettings'),
	v.literal('unifiedMessages'),
	v.literal('channelConfigs'),
	v.literal('agentMetrics'),
	v.literal('llmUsageEvents'),
	v.literal('agentCircuitBreakers'),
	v.literal('agentConfig'),
	v.literal('autonomyFeedback'),
	v.literal('autonomyRules'),
	v.literal('autonomySuggestions'),
	v.literal('mailThreads'),
	v.literal('mailContacts'),
	v.literal('mailSenderCategoryOverrides'),
	v.literal('mailForwarding'),
	v.literal('mailVacationResponders'),
	v.literal('mailVacationLog'),
	v.literal('mailAuditLog'),
	v.literal('mailAuthFailures'),
	v.literal('mailboxMigrations'),
	v.literal('externalMailFolderSync'),
	v.literal('externalMailAccounts'),
	v.literal('pendingMailboxes'),
	v.literal('webhookPayloads'),
	v.literal('automationStatShards'),
	v.literal('campaignSendJobs'),
	v.literal('campaignStatShards'),
	v.literal('sendDailyStats'),
	v.literal('contactTopics'),
	v.literal('contactPropertyValues'),
	v.literal('contactActivities'),
	v.literal('contactIdentities'),
	v.literal('contactRelationships'),
	v.literal('knowledgeRelations'),
	v.literal('knowledgeBackfillJobs'),
	v.literal('knowledgeEdgeBackfillJobs'),
	v.literal('knowledgeGraphStats'),
	v.literal('chatMentions'),
	v.literal('chatMessages'),
	v.literal('chatRoomMembers'),
	v.literal('chatRooms'),
	v.literal('aiMessages'),
	v.literal('aiConversations'),
	v.literal('coalesceBatches'),
	v.literal('visualizations'),
	v.literal('dashboardLayouts'),
	v.literal('shareLinks'),
	v.literal('integrationImports'),
	v.literal('codeWorkTasks'),
);

export const DEFAULT_BATCH_SIZE = 100;

export interface DeleteBatchOutcome {
	deletedCount: number;
	hasMore: boolean;
}

/**
 * Contract for one **Organization deletion step (module)**. Each module
 * owns one table — see the file under `steps/<table>.ts`.
 *
 * The walker calls `deleteBatch` and re-fires the same step until
 * `hasMore: false`. Per-row storage purges happen inside `deleteBatch`
 * before each `ctx.db.delete`; storage purging is internal to the
 * module (per-row, not per-batch), so it does not surface in the
 * walker-facing interface.
 */
export interface OrganizationDeletionStepModule<
	T extends OrganizationDeletionTable,
> {
	readonly table: T;
	readonly batchSize?: number;
	deleteBatch(ctx: MutationCtx): Promise<DeleteBatchOutcome>;
}

/**
 * Helper for declaring a step module — preserves the literal `table`
 * type so the registry in `walker.ts` is type-safe at the per-key level
 * (`ORGANIZATION_DELETION_STEPS['mediaAssets']` has `table: 'mediaAssets'`,
 * not the broad union).
 */
export function defineStep<T extends OrganizationDeletionTable>(
	module: OrganizationDeletionStepModule<T>,
): OrganizationDeletionStepModule<T> {
	return module;
}
