/**
 * The organization-deletion CASCADE: the typed dispatch registry the walker
 * drives. The ordered table list lives in `cascadeOrder.ts` (re-exported here
 * as `STEPS`) so neither file outgrows the ~500 LOC ratchet.
 *
 * Split out of `walker.ts` for the ~500 LOC ratchet, and the seam is where the
 * churn is: this file grows a line every time a per-org table is added, while
 * the walker's `start`/`runStep` plumbing beside it has not changed in the same
 * time. The compile-time exhaustiveness guard travels with the list it guards.
 *
 * See docs/adr/0025-organization-deletion-module-family.md.
 */

import type { OrganizationDeletionStepModule, OrganizationDeletionTable } from './_common';

// Distinct steps with per-row side effects the generic sweep can't express:
// storage-blob purges (mediaAssets / semanticFiles / mailMessages / inboundMessages /
// mailDrafts / transactionalSends / the team reply tables) and delegated cascades (contacts →
// permanentlyDeleteContactWithRelations, domains → sendingDomainLifecycle.remove).
// Every other table is a pure `take + delete` sweep, expressed inline below via
// makeSweepStep — no per-table file needed.
import { mediaAssetsStep } from './mediaAssets';
import { accountExportArtifactsStep } from './accountExportArtifacts';
import { semanticFilesStep } from './semanticFiles';
import { mailMessagesStep } from './mailMessages';
import { mailMessagePartsStep } from './mailMessageParts';
import { inboundMessagesStep } from './inboundMessages';
import { conversationThreadsStep, inboxFollowUpsStep } from './teamReplies';
import { mailDraftsStep } from './mailDrafts';
import { mailAttachmentSharesStep } from './mailAttachmentShares';
import { mailArchiveImportsStep } from './mailArchiveImports';
import { transactionalPendingUploadsStep, transactionalSendsStep } from './transactionalSends';
import { contactsStep } from './contacts';
import { domainsStep } from './domains';
import { makeSweepStep } from './sweep';
import { storageUploadsStep } from './storageUploads';
import { instanceSettingsStep } from './instanceSettings';

import { STEPS } from './cascadeOrder';

export { STEPS };

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
	storageUploads: storageUploadsStep,
	accountExportArtifactLeases: makeSweepStep('accountExportArtifactLeases'),
	accountExportArtifacts: accountExportArtifactsStep,
	accountExportSessions: makeSweepStep('accountExportSessions'),
	mediaAssets: mediaAssetsStep,
	semanticFileContacts: makeSweepStep('semanticFileContacts'),
	semanticFiles: semanticFilesStep,
	mailAttachments: makeSweepStep('mailAttachments'),
	mailAttachmentBackfillJobs: makeSweepStep('mailAttachmentBackfillJobs'),
	mailBodySearchBackfillJobs: makeSweepStep('mailBodySearchBackfillJobs'),
	mailMessageBodies: makeSweepStep('mailMessageBodies'),
	mailMessages: mailMessagesStep,
	mailMessageParts: mailMessagePartsStep,
	mailDrafts: mailDraftsStep,
	transactionalPendingUploads: transactionalPendingUploadsStep,
	transactionalSends: transactionalSendsStep,
	emailSends: makeSweepStep('emailSends'),
	agentActions: makeSweepStep('agentActions'),
	contentScanResults: makeSweepStep('contentScanResults'),
	inboundMessages: inboundMessagesStep,
	conversationThreads: conversationThreadsStep,
	counterScopes: makeSweepStep('counterScopes'),
	counterBuckets: makeSweepStep('counterBuckets'),
	mailFolderMembership: makeSweepStep('mailFolderMembership'),
	mailFolderUidBlocks: makeSweepStep('mailFolderUidBlocks'),
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
	mailboxUsage: makeSweepStep('mailboxUsage'),
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
	contactErasureJobs: makeSweepStep('contactErasureJobs'),
	contacts: contactsStep,
	contactPropertyDeletionJobs: makeSweepStep('contactPropertyDeletionJobs'),
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
	featureFlagSettings: makeSweepStep('featureFlagSettings'),
	instanceCounters: makeSweepStep('instanceCounters'),
	instanceSettings: instanceSettingsStep,
	threadPresence: makeSweepStep('threadPresence'),
	threadReads: makeSweepStep('threadReads'),
	threadNoteMentions: makeSweepStep('threadNoteMentions'),
	threadNotes: makeSweepStep('threadNotes'),
	inboxFollowUps: inboxFollowUpsStep,
	threadCatchUps: makeSweepStep('threadCatchUps'),
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
	inboxSlaPolicies: makeSweepStep('inboxSlaPolicies'),
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
	mailThreadVisits: makeSweepStep('mailThreadVisits'),
	todayStates: makeSweepStep('todayStates'),
	todayThreadSummaries: makeSweepStep('todayThreadSummaries'),
	mailForwarding: makeSweepStep('mailForwarding'),
	mailVacationResponders: makeSweepStep('mailVacationResponders'),
	mailVacationLog: makeSweepStep('mailVacationLog'),
	mailAuditLog: makeSweepStep('mailAuditLog'),
	mailAuthFailures: makeSweepStep('mailAuthFailures'),
	mailboxMigrations: makeSweepStep('mailboxMigrations'),
	mailArchiveImports: mailArchiveImportsStep,
	mailboxMoves: makeSweepStep('mailboxMoves'),
	externalMailFolderSync: makeSweepStep('externalMailFolderSync'),
	externalMailAccessTokens: makeSweepStep('externalMailAccessTokens'),
	externalMailRemoteOps: makeSweepStep('externalMailRemoteOps'),
	externalMailAccounts: makeSweepStep('externalMailAccounts'),
	externalMailOAuthStates: makeSweepStep('externalMailOAuthStates'),
	pendingMailboxes: makeSweepStep('pendingMailboxes'),
	mailboxRequests: makeSweepStep('mailboxRequests'),
	accessRequests: makeSweepStep('accessRequests'),
	webhookPayloads: makeSweepStep('webhookPayloads'),
	automationStatShards: makeSweepStep('automationStatShards'),
	campaignSendJobs: makeSweepStep('campaignSendJobs'),
	audienceCountJobs: makeSweepStep('audienceCountJobs'),
	campaignStatShards: makeSweepStep('campaignStatShards'),
	sendTimeHistogramShards: makeSweepStep('sendTimeHistogramShards'),
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
	answerAskSessions: makeSweepStep('answerAskSessions'),
	aiProviderConfig: makeSweepStep('aiProviderConfig'),
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
