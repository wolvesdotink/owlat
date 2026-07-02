import type { TableNames } from '../_generated/dataModel';

/**
 * The single source of truth for "which tables hold tenant business data".
 *
 * Two full-wipe paths consume this list:
 *   - `devShortcuts/reset.ts` — wipes the instance back to a blank slate.
 *   - the organization-deletion walker (organizations/deletion) — GDPR wipe
 *     for an owner's account deletion and 'Delete organization', with a
 *     compile-time guard that every table here has a walker step.
 *
 * This deployment hosts exactly one organization (see
 * `lib/sessionOrganization.ts`), so "the organization's data" *is* the entire
 * tenant dataset — both paths delete every row of every table below.
 *
 * Tables are ordered children-before-parents. Convex deletes are independent
 * (there is no enforced referential integrity), so the ordering is defensive
 * hygiene rather than a correctness requirement, but it keeps the intent legible.
 *
 * Previously this list was copy-pasted into both wipers and had silently
 * drifted — account deletion was leaving a deleted user's Postbox mail,
 * knowledge graph, chat history, and agent state behind. The compile-time guard
 * at the bottom of this file now forces every schema table to be classified as
 * either tenant data (here) or non-tenant (handled separately), so the lists
 * can never drift again.
 */
export const TENANT_TABLES = [
	// ── Contacts subtree (children first) ──
	'contactPropertyValues',
	'contactTopics',
	'contactActivities',
	'contactIdentities',
	'contactRelationships',
	'emailSends',
	'contacts',
	'contactProperties',

	// ── Automations (children first) ──
	'automationStepRuns',
	'automationRuns',
	'automationSteps',
	'automationStatShards',
	'automations',

	// ── Transactional ──
	'transactionalSends',
	'transactionalEmails',

	// ── Webhooks ──
	'webhookDeliveryLogs',
	'webhookPayloads',
	'webhooks',

	// ── Forms ──
	'formSubmissions',
	'formEndpoints',

	// ── Templates & content ──
	'emailTemplates',
	'emailBlocks',

	// ── Campaigns (children first) ──
	'campaignSendJobs',
	'campaignStatShards',
	'campaigns',

	// ── Topics & segments ──
	'topics',
	'segments',

	// ── Sending domains & deliverability ──
	'sendingDomainMtaIdentities',
	'sendingDomainSesIdentities',
	'trackingDomains',
	'sendingReputation',
	'sendDailyStats',
	'contentScanResults',
	'domains',

	// ── Inbox / inbound pipeline ──
	'inboundMessages',
	'conversationThreads',
	'coalesceBatches',

	// ── Unified messaging & channels ──
	'unifiedMessages',
	'channelConfigs',

	// ── Knowledge graph (children first) ──
	'knowledgeEntryContacts',
	'knowledgeRelations',
	'knowledgeEntries',
	'knowledgeBackfillJobs',
	'knowledgeEdgeBackfillJobs',
	'knowledgeGraphStats',

	// ── Agent + autonomy ──
	'agentActions',
	'agentMetrics',
	'llmUsageEvents',
	'agentCircuitBreakers',
	'agentConfig',
	'autonomyFeedback',
	'autonomyRules',

	// ── Personal mail (Postbox) — children first, mailbox last ──
	'mailMessages',
	'mailThreads',
	'mailDrafts',
	'mailLabels',
	'mailFolders',
	'mailFilters',
	'mailSignatures',
	'mailUserSettings',
	'mailAliases',
	'mailForwarding',
	'mailVacationResponders',
	'mailVacationLog',
	'mailAppPasswords',
	'mailContacts',
	'mailSenderCategoryOverrides',
	'mailAuditLog',
	'mailAuthFailures',
	'mailboxMigrations',
	'externalMailFolderSync',
	'externalMailAccounts',
	'mailboxes',
	'pendingMailboxes',

	// ── Chat (children first) ──
	'chatMentions',
	'chatMessages',
	'chatRoomMembers',
	'chatRooms',

	// ── AI assistant (children first) ──
	'aiMessages',
	'aiConversations',

	// ── Dashboard & visualizations ──
	'visualizations',
	'dashboardLayouts',

	// ── Files & media (junction before parent) ──
	'mediaAssets',
	'semanticFileContacts',
	'semanticFiles',

	// ── Misc tenant data ──
	'shareLinks',
	'integrationImports',
	'codeWorkTasks',
	'apiKeys',
	'blockedEmails',
	'auditLogs',
] as const satisfies readonly TableNames[];

/**
 * Tables deliberately NOT wiped by the tenant-data paths, with the reason each
 * is excluded. Listed explicitly so the exhaustiveness guard below can prove
 * the union of {tenant, non-tenant} covers the whole schema.
 */
export const NON_TENANT_TABLES = [
	// Auth identity — deleted explicitly by the account-deletion / reset paths,
	// or owned by BetterAuth (user/account/organization/member live in the
	// betterAuth component schema, not here).
	'userProfiles',
	'onboardingProgress',
	'platformAdmins',
	// The deletion-tracking table itself — account deletion patches the request
	// row to `completed`, so it must survive the wipe.
	'accountDeletionRequests',
	// Instance configuration singleton — recreated by setup; reset clears it in a
	// dedicated step.
	'instanceSettings',
	// Instance infrastructure / regenerable caches — not org business data.
	'systemUpdates',
	'urlReputationCache',
	'providerRoutes',
	'providerHealth',
	'warmingState',
] as const satisfies readonly TableNames[];

/**
 * Compile-time guard: every table in the schema must be classified as either
 * tenant data or non-tenant. If you add a table to the schema without placing
 * it in one of the lists above, this errors with the offending table name(s).
 */
type UnclassifiedTable = Exclude<
	TableNames,
	(typeof TENANT_TABLES)[number] | (typeof NON_TENANT_TABLES)[number]
>;
type AssertAllTablesClassified<_T extends never> = true;
export type _TenantTablesAreExhaustive = AssertAllTablesClassified<UnclassifiedTable>;
