/**
 * Organization deletion dispatch registry — one module per
 * `OrganizationDeletionTable`.
 *
 * Split out of `walker.ts` (which owns the ordered cascade and the lifecycle
 * plumbing) so the table→module map can keep growing with the schema without
 * pushing the walker past the file-size gate. The two are checked against each
 * other at compile time: the walker's `_StepsCoverEveryTable` guard asserts
 * every table here has a position in the cascade, and the `satisfies` below
 * asserts every table in the cascade has a module.
 *
 * See docs/adr/0025-organization-deletion-module-family.md.
 */

import type { OrganizationDeletionStepModule, OrganizationDeletionTable } from './steps/_common';

// Distinct steps with per-row side effects the generic sweep can't express:
// storage-blob purges (mediaAssets / semanticFiles / mailMessages /
// mailDrafts / transactionalSends) and delegated cascades (contacts →
// permanentlyDeleteContactWithRelations, domains → sendingDomainLifecycle.remove).
// Every other table is a pure `take + delete` sweep, expressed inline below via
// makeSweepStep — no per-table file needed.
import { mediaAssetsStep } from './steps/mediaAssets';
import { accountExportArtifactsStep } from './steps/accountExportArtifacts';
import { semanticFilesStep } from './steps/semanticFiles';
import { mailMessagesStep } from './steps/mailMessages';
import { mailDraftsStep } from './steps/mailDrafts';
import { transactionalSendsStep } from './steps/transactionalSends';
import { contactsStep } from './steps/contacts';
import { domainsStep } from './steps/domains';
import { makeSweepStep } from './steps/sweep';

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
	mailSignatures: makeSweepStep('mailSignatures'),
	mailSnippets: makeSweepStep('mailSnippets'),
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
	mailCommitments: makeSweepStep('mailCommitments'),
	mailDailyBriefs: makeSweepStep('mailDailyBriefs'),
	mailBriefCards: makeSweepStep('mailBriefCards'),
	mailForwarding: makeSweepStep('mailForwarding'),
	mailVacationResponders: makeSweepStep('mailVacationResponders'),
	mailVacationLog: makeSweepStep('mailVacationLog'),
	mailAuditLog: makeSweepStep('mailAuditLog'),
	mailAuthFailures: makeSweepStep('mailAuthFailures'),
	mailboxMigrations: makeSweepStep('mailboxMigrations'),
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
	ostrEvidence: makeSweepStep('ostrEvidence'),
	ostrReportQueue: makeSweepStep('ostrReportQueue'),
	ostrBatchCommitments: makeSweepStep('ostrBatchCommitments'),
	ostrObserverState: makeSweepStep('ostrObserverState'),
} as const satisfies {
	readonly [K in OrganizationDeletionTable]: OrganizationDeletionStepModule<K>;
};
