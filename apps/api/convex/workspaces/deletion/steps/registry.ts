/**
 * The organization-deletion CASCADE: the ordered table list and the typed
 * dispatch registry the walker drives.
 *
 * Split out of `walker.ts` for the ~500 LOC ratchet, and the seam is where the
 * churn is: this file grows a line every time a per-org table is added, while
 * the walker's `start`/`runStep` plumbing beside it has not changed in the same
 * time. The compile-time exhaustiveness guard travels with the list it guards.
 *
 * See docs/adr/0025-organization-deletion-module-family.md.
 */

import type {
	OrganizationDeletionStepModule,
	OrganizationDeletionTable,
} from './_common';

// Distinct steps with per-row side effects the generic sweep can't express:
// storage-blob purges (mediaAssets / semanticFiles / mailMessages /
// mailDrafts / transactionalSends) and delegated cascades (contacts →
// permanentlyDeleteContactWithRelations, domains → sendingDomainLifecycle.remove).
// Every other table is a pure `take + delete` sweep, expressed inline below via
// makeSweepStep — no per-table file needed.
import { mediaAssetsStep } from './mediaAssets';
import { accountExportArtifactsStep } from './accountExportArtifacts';
import { semanticFilesStep } from './semanticFiles';
import { mailMessagesStep } from './mailMessages';
import { mailDraftsStep } from './mailDrafts';
import { mailAttachmentSharesStep } from './mailAttachmentShares';
import { mailArchiveImportsStep } from './mailArchiveImports';
import { transactionalSendsStep } from './transactionalSends';
import { contactsStep } from './contacts';
import { domainsStep } from './domains';
import { makeSweepStep } from './sweep';

/**
 * Ordered cascade: children before parents, storage-bearing tables
 * purge their blobs before row delete, audit logs second-to-last (they
 * accumulate from delegated lifecycle calls during the wipe), and the
 * terminal `instanceSettings` row last (the singleton that owned the
 * organization).
 *
 * The order matters: by the time the `contacts` step runs, all
 * `emailSends` / `transactionalSends` are already gone — the
 * delegated `permanentlyDeleteContactWithRelations` helper's
 * soft-mark-sends loop is a no-op index lookup, no waste.
 */
export const STEPS: readonly [OrganizationDeletionTable, ...OrganizationDeletionTable[]] = [
	'accountExportArtifactLeases',
	'accountExportArtifacts',
	'accountExportSessions',
	// Storage-bearing leaves: storage hooks fire before row delete
	'mediaAssets',
	'semanticFileContacts', // junction mirror — clear before its parent files
	'semanticFiles',
	// Attachment index: a junction mirror of mailMessages, cleared before its
	// parent rows so the sweep never leaves a file pointing at a deleted message.
	'mailAttachments',
	'mailAttachmentBackfillJobs',
	'mailBodySearchBackfillJobs',
	'mailMessages',
	'mailDrafts',
	// Share links own the blobs the drafts above no longer reference, so they
	// have to purge their own storage rather than ride a generic sweep.
	'mailAttachmentShares',
	'transactionalSends',

	// Send + dispatch leaves
	'emailSends',
	'agentActions',
	'agentMetrics',
	'llmUsageEvents',
	'agentCircuitBreakers',
	'agentConfig',
	'autonomyFeedback',
	'autonomyRules',
	'autonomySuggestions',
	'handlingRules',
	'askEagernessSettings',
	'clarificationAskLog',
	'clarificationMemory',
	'agentShadowDecisions',
	'agentShadowScorecard',
	'contentScanResults',

	// Conversation parents (after their leaves)
	'unifiedMessages',
	'threadPresence', // ephemeral viewer/replier signals — clear before their threads
	'threadReads', // per-user read markers — clear before their threads
	'inboxAssignmentNotices', // per-assignee notice denormalized subjects/assigner names
	'inboundMessages',
	'conversationThreads',
	'channelConfigs',

	// Postbox sidecar family (children + logs before mailboxes)
	'mailThreads',
	'mailContacts',
	'mailSenderCategoryOverrides',
	'mailSenderImageAllowlist',
	'mailTriageTallies',
	'mailCommitments',
	'mailDailyBriefs',
	'mailBriefCards',
	'mailForwarding',
	'mailVacationResponders',
	'mailVacationLog',
	'mailAuditLog',
	'mailAuthFailures',
	'externalMailFolderSync',
	'externalMailAccounts',
	'mailboxMigrations',
	'mailArchiveImports',
	'mailboxMoves',
	'pendingMailboxes',
	'mailboxRequests',
	'accessRequests',

	// Postbox configuration before mailboxes
	'mailAliases',
	'mailFolders',
	'mailLabels',
	'mailVoiceProfiles',
	'mailContactStyleOverrides',
	'mailFilters',
	'mailFilterRunJobs',
	'mailSignatures',
	'mailSnippets',
	'mailSavedSearches',
	'mailUserSettings',
	'mailAppPasswords',
	'mailboxMembers',
	'pendingMailboxMembers',
	'mailboxes',

	// Delivery reputation history — standalone daily snapshots, no dependents
	'deliverySnapshots',
	'seedPlacementProbes',
	'gmailDeliveryReceipts',
	'gmailVolumeBuckets',
	'gmailDomainVolumeRollups',
	'gmailDomainVolumeRollupJobs',
	'googlePostmasterStats',
	'googlePostmasterCompliance',
	'unsubscribeLatencyBuckets',

	// Webhook / form children before parents
	'webhookDeliveryLogs',
	'mtaCampaignAlertReceipts',
	'webhookPayloads',
	'webhooks',
	'formSubmissions',
	'formEndpoints',

	// Automation children before parents
	'automationStepRuns',
	'automationRuns',
	'automationSteps',
	'automationStatShards',
	'automations',

	// Campaign machinery before the campaign parents
	'campaignSendJobs',
	'campaignStatShards',
	'campaignSenders',
	'sendDailyStats',

	// Campaign + template parents
	'campaigns',
	// Version snapshots before the templates they belong to.
	'emailTemplateVersions',
	'emailTemplates',
	'transactionalEmails',
	'emailBlocks',

	// Contact cascade — delegates; sweeps 5 child tables that aren't
	// standalone steps (contactTopics, contactPropertyValues,
	// contactActivities, contactIdentities, contactRelationships)
	'contacts',

	// Orphan sweeps: the contacts step delegates these per contact, but rows
	// whose parent is already gone would survive — sweep the remainder.
	'contactTopics',
	'contactPropertyValues',
	'contactActivities',
	'contactIdentities',
	'contactRelationships',

	// Per-topic sunset-policy overrides (P4-4) — configuration rows with no
	// parent among the contact tables.
	'sunsetPolicies',

	// Independent definitions (no parent/child among themselves)
	'contactProperties',
	'topics',
	'segments',
	'apiKeys',
	'blockedEmails',
	'knowledgeEntryContacts', // junction mirror — clear before its parent entries
	'knowledgeRelations',
	'knowledgeEntries',
	'knowledgeBackfillJobs',
	'knowledgeEdgeBackfillJobs',
	'knowledgeGraphStats',

	// Domain stack — reputation before domains. The domains step clears BOTH
	// identity siblings and schedules both external provider deletions, so it
	// must run before the orphan-sweep fallbacks erase that routing evidence.
	'trackingDomains',
	'sendingReputation',
	'providerHealth',
	'providerRoutes',
	'deliverabilityRouteStates',
	'deliverabilityAlignmentStates',
	'deliverabilityAlertRecipients',
	'deliverabilityAlertRecipientReceipts',
	'deliverabilityRegressionAlerts',
	'deliverabilityVerificationState',
	'deliverabilityEvidence',
	'deliverabilityLoopbackAttempts',
	'destinationProviderDomains',
	'sendAssignments',
	'transportOutcomes',
	'smtpResponseCategories',
	'mixDecisions',
	'rampStreamPresets',
	'yahooCflEnrollments',
	'domains',
	'sendingDomainMtaIdentities',
	'sendingDomainSesIdentities',
	'sendingDomainRelayIdentities',

	// Chat (children before parents)
	'chatMentions',
	'chatMessages',
	'chatRoomMembers',
	'chatRooms',

	// AI assistant (children before parent)
	'aiMessages',
	'aiConversations',

	// AI draft-revise stream buffers (ephemeral, owner-scoped)
	'aiDraftStreams',

	// Independent feature state
	'coalesceBatches',
	'visualizations',
	'dashboardLayouts',
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

	// UI / onboarding state
	'onboardingProgress',

	// Invitation resend throttle rows — pure org data, no dependents.
	'invitationResends',

	// Audit logs LAST (accumulates from delegated lifecycle calls above)
	'auditLogs',

	// Terminal — the singleton row that owned the org's existence
	'instanceSettings',
] as const;

/**
 * Compile-time guard: STEPS must visit every OrganizationDeletionTable —
 * a registry entry without a position in the cascade would never run.
 */
type TableMissingFromSteps = Exclude<OrganizationDeletionTable, (typeof STEPS)[number]>;
type AssertStepsExhaustive<_T extends never> = true;
export type _StepsCoverEveryTable = AssertStepsExhaustive<TableMissingFromSteps>;

/**
 * Typed dispatch registry — one module per `OrganizationDeletionTable`.
 * The `satisfies` keeps the per-key literal type narrow at use sites
 * (`ORGANIZATION_DELETION_STEPS['mediaAssets'].table === 'mediaAssets'`,
 * not the broad union) while still type-checking exhaustiveness across
 * the union.
 */
export const ORGANIZATION_DELETION_STEPS = {
	accountExportArtifactLeases: makeSweepStep('accountExportArtifactLeases'),
	accountExportArtifacts: accountExportArtifactsStep,
	accountExportSessions: makeSweepStep('accountExportSessions'),
	mediaAssets: mediaAssetsStep,
	semanticFileContacts: makeSweepStep('semanticFileContacts'),
	semanticFiles: semanticFilesStep,
	mailAttachments: makeSweepStep('mailAttachments'),
	mailAttachmentBackfillJobs: makeSweepStep('mailAttachmentBackfillJobs'),
	mailBodySearchBackfillJobs: makeSweepStep('mailBodySearchBackfillJobs'),
	mailMessages: mailMessagesStep,
	mailDrafts: mailDraftsStep,
	transactionalSends: transactionalSendsStep,
	emailSends: makeSweepStep('emailSends'),
	agentActions: makeSweepStep('agentActions'),
	contentScanResults: makeSweepStep('contentScanResults'),
	inboundMessages: makeSweepStep('inboundMessages'),
	conversationThreads: makeSweepStep('conversationThreads'),
	mailAliases: makeSweepStep('mailAliases'),
	mailFolders: makeSweepStep('mailFolders'),
	mailLabels: makeSweepStep('mailLabels'),
	mailVoiceProfiles: makeSweepStep('mailVoiceProfiles'),
	mailContactStyleOverrides: makeSweepStep('mailContactStyleOverrides'),
	mailFilters: makeSweepStep('mailFilters'),
	mailFilterRunJobs: makeSweepStep('mailFilterRunJobs'),
	mailSignatures: makeSweepStep('mailSignatures'),
	mailSnippets: makeSweepStep('mailSnippets'),
	mailSavedSearches: makeSweepStep('mailSavedSearches'),
	mailUserSettings: makeSweepStep('mailUserSettings'),
	mailAppPasswords: makeSweepStep('mailAppPasswords'),
	mailboxMembers: makeSweepStep('mailboxMembers'),
	pendingMailboxMembers: makeSweepStep('pendingMailboxMembers'),
	mailboxes: makeSweepStep('mailboxes'),
	deliverySnapshots: makeSweepStep('deliverySnapshots'),
	seedPlacementProbes: makeSweepStep('seedPlacementProbes'),
	gmailDeliveryReceipts: makeSweepStep('gmailDeliveryReceipts'),
	gmailVolumeBuckets: makeSweepStep('gmailVolumeBuckets'),
	gmailDomainVolumeRollups: makeSweepStep('gmailDomainVolumeRollups'),
	gmailDomainVolumeRollupJobs: makeSweepStep('gmailDomainVolumeRollupJobs'),
	googlePostmasterStats: makeSweepStep('googlePostmasterStats'),
	googlePostmasterCompliance: makeSweepStep('googlePostmasterCompliance'),
	unsubscribeLatencyBuckets: makeSweepStep('unsubscribeLatencyBuckets'),
	webhookDeliveryLogs: makeSweepStep('webhookDeliveryLogs'),
	mtaCampaignAlertReceipts: makeSweepStep('mtaCampaignAlertReceipts'),
	webhooks: makeSweepStep('webhooks'),
	formSubmissions: makeSweepStep('formSubmissions'),
	formEndpoints: makeSweepStep('formEndpoints'),
	automationStepRuns: makeSweepStep('automationStepRuns'),
	automationRuns: makeSweepStep('automationRuns'),
	automationSteps: makeSweepStep('automationSteps'),
	automations: makeSweepStep('automations'),
	campaigns: makeSweepStep('campaigns'),
	emailTemplateVersions: makeSweepStep('emailTemplateVersions'),
	emailTemplates: makeSweepStep('emailTemplates'),
	transactionalEmails: makeSweepStep('transactionalEmails'),
	emailBlocks: makeSweepStep('emailBlocks'),
	contacts: contactsStep,
	contactProperties: makeSweepStep('contactProperties'),
	topics: makeSweepStep('topics'),
	segments: makeSweepStep('segments'),
	apiKeys: makeSweepStep('apiKeys'),
	blockedEmails: makeSweepStep('blockedEmails'),
	knowledgeEntryContacts: makeSweepStep('knowledgeEntryContacts'),
	knowledgeEntries: makeSweepStep('knowledgeEntries'),
	sendingDomainMtaIdentities: makeSweepStep('sendingDomainMtaIdentities'),
	sendingDomainSesIdentities: makeSweepStep('sendingDomainSesIdentities'),
	sendingDomainRelayIdentities: makeSweepStep('sendingDomainRelayIdentities'),
	trackingDomains: makeSweepStep('trackingDomains'),
	sendingReputation: makeSweepStep('sendingReputation'),
	providerHealth: makeSweepStep('providerHealth'),
	providerRoutes: makeSweepStep('providerRoutes'),
	deliverabilityRouteStates: makeSweepStep('deliverabilityRouteStates'),
	deliverabilityAlignmentStates: makeSweepStep('deliverabilityAlignmentStates'),
	deliverabilityAlertRecipients: makeSweepStep('deliverabilityAlertRecipients'),
	deliverabilityAlertRecipientReceipts: makeSweepStep('deliverabilityAlertRecipientReceipts'),
	deliverabilityRegressionAlerts: makeSweepStep('deliverabilityRegressionAlerts'),
	deliverabilityVerificationState: makeSweepStep('deliverabilityVerificationState'),
	deliverabilityEvidence: makeSweepStep('deliverabilityEvidence'),
	deliverabilityLoopbackAttempts: makeSweepStep('deliverabilityLoopbackAttempts'),
	destinationProviderDomains: makeSweepStep('destinationProviderDomains'),
	sendAssignments: makeSweepStep('sendAssignments'),
	transportOutcomes: makeSweepStep('transportOutcomes'),
	smtpResponseCategories: makeSweepStep('smtpResponseCategories'),
	mixDecisions: makeSweepStep('mixDecisions'),
	rampStreamPresets: makeSweepStep('rampStreamPresets'),
	yahooCflEnrollments: makeSweepStep('yahooCflEnrollments'),
	domains: domainsStep,
	onboardingProgress: makeSweepStep('onboardingProgress'),
	invitationResends: makeSweepStep('invitationResends'),
	auditLogs: makeSweepStep('auditLogs'),
	instanceSettings: makeSweepStep('instanceSettings'),
	threadPresence: makeSweepStep('threadPresence'),
	threadReads: makeSweepStep('threadReads'),
	inboxAssignmentNotices: makeSweepStep('inboxAssignmentNotices'),
	unifiedMessages: makeSweepStep('unifiedMessages'),
	channelConfigs: makeSweepStep('channelConfigs'),
	agentMetrics: makeSweepStep('agentMetrics'),
	llmUsageEvents: makeSweepStep('llmUsageEvents'),
	agentCircuitBreakers: makeSweepStep('agentCircuitBreakers'),
	agentConfig: makeSweepStep('agentConfig'),
	autonomyFeedback: makeSweepStep('autonomyFeedback'),
	autonomyRules: makeSweepStep('autonomyRules'),
	autonomySuggestions: makeSweepStep('autonomySuggestions'),
	handlingRules: makeSweepStep('handlingRules'),
	askEagernessSettings: makeSweepStep('askEagernessSettings'),
	clarificationAskLog: makeSweepStep('clarificationAskLog'),
	clarificationMemory: makeSweepStep('clarificationMemory'),
	agentShadowDecisions: makeSweepStep('agentShadowDecisions'),
	agentShadowScorecard: makeSweepStep('agentShadowScorecard'),
	mailThreads: makeSweepStep('mailThreads'),
	mailContacts: makeSweepStep('mailContacts'),
	mailSenderCategoryOverrides: makeSweepStep('mailSenderCategoryOverrides'),
	mailSenderImageAllowlist: makeSweepStep('mailSenderImageAllowlist'),
	mailAttachmentShares: mailAttachmentSharesStep,
	mailTriageTallies: makeSweepStep('mailTriageTallies'),
	mailCommitments: makeSweepStep('mailCommitments'),
	mailDailyBriefs: makeSweepStep('mailDailyBriefs'),
	mailBriefCards: makeSweepStep('mailBriefCards'),
	mailForwarding: makeSweepStep('mailForwarding'),
	mailVacationResponders: makeSweepStep('mailVacationResponders'),
	mailVacationLog: makeSweepStep('mailVacationLog'),
	mailAuditLog: makeSweepStep('mailAuditLog'),
	mailAuthFailures: makeSweepStep('mailAuthFailures'),
	mailboxMigrations: makeSweepStep('mailboxMigrations'),
	mailArchiveImports: mailArchiveImportsStep,
	mailboxMoves: makeSweepStep('mailboxMoves'),
	externalMailFolderSync: makeSweepStep('externalMailFolderSync'),
	externalMailAccounts: makeSweepStep('externalMailAccounts'),
	pendingMailboxes: makeSweepStep('pendingMailboxes'),
	mailboxRequests: makeSweepStep('mailboxRequests'),
	accessRequests: makeSweepStep('accessRequests'),
	webhookPayloads: makeSweepStep('webhookPayloads'),
	automationStatShards: makeSweepStep('automationStatShards'),
	campaignSendJobs: makeSweepStep('campaignSendJobs'),
	campaignStatShards: makeSweepStep('campaignStatShards'),
	campaignSenders: makeSweepStep('campaignSenders'),
	sendDailyStats: makeSweepStep('sendDailyStats'),
	contactTopics: makeSweepStep('contactTopics'),
	contactPropertyValues: makeSweepStep('contactPropertyValues'),
	contactActivities: makeSweepStep('contactActivities'),
	contactIdentities: makeSweepStep('contactIdentities'),
	contactRelationships: makeSweepStep('contactRelationships'),
	sunsetPolicies: makeSweepStep('sunsetPolicies'),
	knowledgeRelations: makeSweepStep('knowledgeRelations'),
	knowledgeBackfillJobs: makeSweepStep('knowledgeBackfillJobs'),
	knowledgeEdgeBackfillJobs: makeSweepStep('knowledgeEdgeBackfillJobs'),
	knowledgeGraphStats: makeSweepStep('knowledgeGraphStats'),
	chatMentions: makeSweepStep('chatMentions'),
	chatMessages: makeSweepStep('chatMessages'),
	chatRoomMembers: makeSweepStep('chatRoomMembers'),
	chatRooms: makeSweepStep('chatRooms'),
	aiMessages: makeSweepStep('aiMessages'),
	aiConversations: makeSweepStep('aiConversations'),
	aiDraftStreams: makeSweepStep('aiDraftStreams'),
	coalesceBatches: makeSweepStep('coalesceBatches'),
	visualizations: makeSweepStep('visualizations'),
	dashboardLayouts: makeSweepStep('dashboardLayouts'),
	connectedApps: makeSweepStep('connectedApps'),
	pluginStorageEntries: makeSweepStep('pluginStorageEntries'),
	pluginStorageUsage: makeSweepStep('pluginStorageUsage'),
	pluginLlmReservations: makeSweepStep('pluginLlmReservations'),
	pluginLlmDailyUsage: makeSweepStep('pluginLlmDailyUsage'),
	pluginTasks: makeSweepStep('pluginTasks'),
	draftStrategySelections: makeSweepStep('draftStrategySelections'),
	shareLinks: makeSweepStep('shareLinks'),
	integrationImports: makeSweepStep('integrationImports'),
	codeWorkTasks: makeSweepStep('codeWorkTasks'),
} as const satisfies {
	readonly [K in OrganizationDeletionTable]: OrganizationDeletionStepModule<K>;
};
