import type { TableNames } from '../_generated/dataModel';
import { THREAD_BRIEF_TABLES } from '../schema/threadBrief';
import { AI_ROUTING_TABLES } from '../schema/aiRouting';
import { MAIL_ARRIVAL_TABLES } from '../schema/mailArrival';
import { MARKETING_NOTIFICATION_TABLES } from '../schema/marketingNotifications';
import { AUTOMATION_TABLES } from '../schema/automations';
import type { NON_TENANT_TABLES } from './nonTenantTables';

/**
 * The single source of truth for "which tables hold tenant business data".
 *
 * Two full-wipe paths consume this list:
 *   - `devShortcuts/reset.ts` — wipes the instance back to a blank slate.
 *   - the organization-deletion walker (workspaces/deletion) — GDPR wipe
 *     for an owner's account deletion and 'Delete organization', with a
 *     compile-time guard that every table here has a walker step.
 *
 * This deployment hosts exactly one organization (see
 * `lib/sessionOrganization.ts`), so "the organization's data" *is* the entire
 * tenant dataset — both paths delete every row of every table below.
 *
 * Tables are ordered children-before-parents: Convex enforces no referential
 * integrity, so the order is defensive hygiene that keeps the intent legible.
 *
 * The guard at the bottom of this file forces every schema table to be
 * classified as either tenant data (here) or non-tenant (`./nonTenantTables.ts`).
 */
export const TENANT_TABLES = [
	'storageUploads',
	// Short-lived export capabilities must be revoked with the single tenant.
	'accountExportArtifactLeases',
	'accountExportArtifacts',
	'accountExportSessions',
	// Maintained counts (plan 3.1): derived from the rows below and wiped first,
	// so the rest of the wipe does not keep moving buckets on its way out.
	'counterScopes',
	'counterBuckets',
	// IMAP folder membership: derived from mailMessages the same way.
	'mailFolderMembership',
	'mailFolderUidBlocks',

	// ── Contacts subtree (children first) ──
	'contactPropertyValues',
	'contactTopics',
	'contactActivities',
	'contactIdentities',
	'contactRelationships',
	// Per-topic sunset-policy overrides. Configuration, not contact data,
	// but it is tenant-owned and must not survive an org wipe.
	'sunsetPolicies',
	'emailSends',
	// Per-contact erasure progress; references the contact rows below.
	'contactErasureJobs',
	'contacts',
	// Property-deletion progress; references the property rows below.
	'contactPropertyDeletionJobs',
	'contactProperties',

	...MARKETING_NOTIFICATION_TABLES, // point at automations, campaigns and domains

	...AUTOMATION_TABLES, // children first

	// ── Transactional ──
	'apiRequestReceipts', // Idempotency-Key receipts: they name the Sends and contacts below
	// API attachment uploads no Send claimed yet; the step frees each blob with its row.
	'transactionalPendingUploads',
	// Recorded send completions that threw: a pointer at a Send plus the
	// worker outcome, which can carry the rendered message. Before both send tables.
	'sendCompletionFailurePayloads',
	'sendCompletionFailures',
	'transactionalSends',
	'transactionalEmails',

	// ── Webhooks ──
	'mtaCampaignAlertReceipts',
	'webhookDeliveryLogs',
	'webhookPayloads',
	// Bounces and complaints that matched no Send, kept for counting and
	// replay: message ids, outcomes and replay state, no addresses.
	'unresolvedFeedback',
	'webhooks',

	// ── Forms ──
	'formSubmissions',
	'formEndpoints',

	// ── Templates & content ──
	// Live co-editing state of an email (ephemeral); goes before the emails.
	'emailCoeditNotices',
	'emailEditorPresence',
	'emailCoeditSessions',
	// Snapshot history holds full copies of the template bodies, so it is the
	// same tenant business data and wipes with (and before) its parent.
	'emailTemplateVersions',
	'emailTemplates',
	'emailBlocks',

	// ── Campaigns (children first) ──
	'campaignSendJobs',
	'audienceCountJobs',
	'campaignStatShards',
	'sendTimeHistogramShards',
	'campaignSenders',
	'campaigns',

	// ── Topics & segments ──
	'topics',
	'segments',

	// ── Sending domains & deliverability ──
	'sendingDomainMtaIdentities',
	'yahooCflEnrollments',
	// DMARC aggregate reports about the org's sending domains: who sends as
	// them, from which IPs. Rows before their report.
	'dmarcReportRecords',
	'dmarcReports',
	'sendingDomainSesIdentities',
	// The generic per-provider relay identity that succeeds the two
	// frozen siblings above. Org-scoped sending-domain state — a wipe must not
	// leave the org's relay verification records behind.
	'sendingDomainRelayIdentities',
	'trackingDomains',
	'sendingReputation',
	'gmailDeliveryReceipts',
	'gmailVolumeBuckets',
	'gmailDomainVolumeRollups',
	'gmailDomainVolumeRollupJobs',
	'googlePostmasterStats',
	'googlePostmasterCompliance',
	'unsubscribeLatencyBuckets',
	'deliverabilityRouteStates',
	'deliverabilityAlignmentStates',
	'deliverabilityAlertRecipients',
	'deliverabilityAlertRecipientReceipts',
	'deliverabilityRegressionAlerts',
	'deliverabilityVerificationState',
	'deliverabilityEvidence',
	'deliverabilityLoopbackAttempts',
	'destinationProviderDomains',
	// The transport-mix experiment record: one row per recipient per send,
	// carrying organizationId and a sendId into emailSends/transactionalSends.
	// Per-recipient tenant business data — a wipe that left it behind would
	// leave the whole experiment record of a deleted org on disk.
	'sendAssignments',
	// Per-cell, per-arm outcome counters derived from that experiment record.
	// Tenant sending history in aggregate form — a wipe must not leave it behind.
	'transportOutcomes',
	// What receivers said in their own 4xx/5xx text, per cell and per arm — the
	// same experiment record one classification further in. Tenant sending
	// history: a wipe must not leave it behind.
	'smtpResponseCategories',
	// Every ramp-controller decision, including no-ops. Tenant
	// sending history: a wipe must not leave the org's ramp audit trail behind.
	'mixDecisions',
	// The per-stream ramp aggressiveness preset an operator chose.
	// Per-organization business configuration — a wipe must not leave it behind.
	'rampStreamPresets',
	// Derived from sendingReputation (tenant data), so a tenant wipe must delete the org's delivery history too.
	'deliverySnapshots',
	'sendDailyStats',
	'contentScanResults',
	'domains',

	// ── Inbox / inbound pipeline ──
	'inboxAssignmentNotices',
	'threadPresence',
	'threadReads',
	'threadNoteMentions',
	'threadNotes',
	'inboxFollowUps',
	// Answer mode catch-up cards of team and Postbox threads: derived from the
	// mail, so they go before the threads they summarise.
	'threadCatchUps',
	// Thread brief (schema/threadBrief.ts) of team and Postbox threads: derived
	// from the mail, so it goes before the threads it describes.
	...THREAD_BRIEF_TABLES,
	// Resumable thread brief purges (schema/threadPurgeJobs.ts): ids only.
	'threadPurgeJobs',
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
	'handlingRules',
	'autonomySuggestions',
	'askEagernessSettings',
	'inboxSlaPolicies',
	'inboxAutoClosePolicies',
	'clarificationAskLog',
	'clarificationMemory',
	'agentShadowDecisions',
	'agentShadowScorecard',

	// ── Personal mail (Postbox) — children first, mailbox last ──
	// The attachment index and its backfill job are derived from `mailMessages`,
	// but they carry this org's filenames and senders verbatim, so they wipe with
	// the mail they mirror rather than being treated as a regenerable cache.
	'mailAttachments',
	'mailAttachmentBackfillJobs',
	// The deep-body-search backfill job (idea 32). Same reasoning as the
	// attachment job above: it is derived bookkeeping over `mailMessages`, but it
	// names this org's mailboxes, so it wipes with the mail it walked. (The
	// excerpt itself is a COLUMN on `mailMessages` and needs no entry here.)
	'mailBodySearchBackfillJobs',
	// The thread brief's 30-day backfill walk (mail/interpret/backfill.ts):
	// bookkeeping over this org's mailboxes, wiped with the mail it walked.
	'interpretBackfillJobs',
	...MAIL_ARRIVAL_TABLES, // read on arrival: records, senders, undo log, rules, digests
	// Inline bodies, 1:1 with the message rows below (plan 3.2).
	'mailMessageBodies',
	'mailMessages',
	// Attachment parts stored out of a raw `.eml` (plan 3.5). Freed with the raw
	// blob by `deleteMessageRowAndBlobs`; listed so an orphan still wipes.
	'mailMessageParts',
	'mailThreads',
	'mailDraftRequestNonces',
	'mailDrafts',
	'mailLabels',
	'mailVoiceProfiles',
	'mailContactStyleOverrides',
	'mailFolders',
	'mailFilters',
	'mailFilterRunJobs',
	'mailSignatures',
	'mailSnippets',
	'mailSavedSearches',
	'mailUserSettings',
	'mailAliases',
	'mailForwarding',
	'mailVacationResponders',
	'mailVacationLog',
	'mailAppPasswords',
	'mailContacts',
	'mailSenderCategoryOverrides',
	'mailSenderImageAllowlist',
	// Attachment share links (idea 10). Each row is one of this org's files —
	// filename, size and the token that opens it — so it wipes with the mail it
	// was lifted out of. Deleting the row is also the only thing that stops the
	// link resolving, which makes leaving it behind unthinkable.
	'mailAttachmentShares',
	'mailTriageTallies',
	'mailCommitments',
	'mailDailyBriefs',
	'mailBriefCards',
	// Today's per-user memory: the seen watermark and thread visits. Both are
	// a member's own reading history, so they go with the tenant.
	'mailThreadVisits',
	'todayStates',
	'todayThreadSummaries',
	// Booking page: a member's page, meeting types and the bookings guests made
	// (children first).
	'bookings',
	'bookingMeetingTypes',
	'bookingProfiles',
	'mailAuditLog',
	'mailAuthFailures',
	'mailboxMigrations',
	'mailArchiveImports',
	'mailboxMoves',
	'externalMailFolderSync',
	// Sealed OAuth access-token cache, one row per oauth2 account.
	'externalMailAccessTokens',
	// Pending local → remote write-backs (moves, flags, deletes) for an account.
	'externalMailRemoteOps',
	'externalMailAccounts',
	// In-flight Google sign-in handshakes for connecting an external mailbox.
	// User- and org-attributed, short-lived, and meaningless once the org is gone
	// — wiped with it like the account rows the finished handshake would write.
	'externalMailOAuthStates',
	// Seed-mailbox placement probe ledger (deliverability gate 5). One row per
	// shadow copy this org's sends dropped into its own seed mailboxes —
	// org-scoped observation data, wiped with the org.
	'seedPlacementProbes',
	'mailboxMembers',
	'pendingMailboxMembers',
	// 1:1 storage accounting row of a mailbox (plan 2.4).
	'mailboxUsage',
	'mailboxes',
	'pendingMailboxes',
	'mailboxRequests',

	// ── Chat (children first) ──
	'chatMentions',
	'chatMessages',
	'chatRoomMembers',
	'chatRooms',

	// ── AI assistant (children first) ──
	'aiMessages',
	'aiConversations',

	// ── AI draft-revise stream buffers (ephemeral, owner-scoped) ──
	'aiDraftStreams',
	// Answer mode ask sessions (owner-scoped, reference drafts and team threads).
	'answerAskSessions',

	// ── AI provider configuration ──
	// The chosen language, embedding and decision providers plus the encrypted
	// API keys someone entered for this workspace. Wiped with the workspace: keys
	// that outlived it would keep billing their owner for whoever sets the
	// workspace up next, behind a masked preview nobody recognises. The
	// deployment's own `LLM_*` env fallback is untouched.
	'aiProviderConfig',
	...AI_ROUTING_TABLES, // AI routing: routing policy, admission, embedding provenance, artifacts

	// ── Dashboard & visualizations ──
	'visualizations',
	'dashboardLayouts',
	// Web Push devices of the workspace's members (push/): their keys would
	// otherwise keep a capability to notify people who are no longer here.
	'pushSubscriptions',

	// ── Files & media (junction before parent) ──
	'mediaAssets',
	'semanticFileContacts',
	'semanticFiles',

	// ── Misc tenant data ──
	'connectedApps',
	'pluginStorageEntries',
	'pluginStorageUsage',
	'pluginLlmReservations',
	'pluginLlmDailyUsage',
	'pluginTasks',
	'draftStrategySelections',
	'shareLinks',
	'integrationImports',
	'codeWorkTasks',
	'apiKeys',
	'blockedEmails',
	'auditLogs',
	'invitationResends',
	'accessRequests',
] as const satisfies readonly TableNames[];

/**
 * Compile-time guard: every table in the schema must be classified as either
 * tenant data or non-tenant. If you add a table to the schema without placing
 * it in one of the two lists, this errors with the offending table name(s).
 */
type UnclassifiedTable = Exclude<
	TableNames,
	(typeof TENANT_TABLES)[number] | (typeof NON_TENANT_TABLES)[number]
>;
type AssertAllTablesClassified<_T extends never> = true;
export type _TenantTablesAreExhaustive = AssertAllTablesClassified<UnclassifiedTable>;
