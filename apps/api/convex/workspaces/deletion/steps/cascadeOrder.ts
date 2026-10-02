/**
 * The organization-deletion cascade ORDER, split out of `registry.ts` for the
 * ~500 LOC ratchet: this list grows a line with every per-org table, while the
 * dispatch map and its exhaustiveness guard in `registry.ts` stay put.
 */

import type { OrganizationDeletionTable } from './_common';

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
	'storageUploads',
	'accountExportArtifactLeases',
	'accountExportArtifacts',
	'accountExportSessions',
	// Derived counts first: the mail and contact wipes below then find no scope
	// to keep in step.
	'counterScopes',
	'counterBuckets',
	'mailFolderMembership',
	'mailFolderUidBlocks',
	// Storage-bearing leaves: storage hooks fire before row delete
	'mediaAssets',
	'semanticFileContacts', // junction mirror — clear before its parent files
	'semanticFiles',
	// Attachment index: a junction mirror of mailMessages, cleared before its
	// parent rows so the sweep never leaves a file pointing at a deleted message.
	'mailAttachments',
	'mailAttachmentBackfillJobs',
	'mailBodySearchBackfillJobs',
	// Inline bodies (plan 3.2), 1:1 with mailMessages: swept before their rows
	// like the attachment index, so no body outlives its message.
	'mailMessageBodies',
	'mailMessages',
	// Parts cut out of a raw `.eml`: the step above frees them with their raw
	// blob, so this only ever finds orphans, and it purges their blobs too.
	'mailMessageParts',
	'mailDrafts',
	// Share links own the blobs the drafts above no longer reference, so they
	// have to purge their own storage rather than ride a generic sweep.
	'mailAttachmentShares',
	// Unclaimed transactional attachment uploads own their blobs outright.
	'transactionalPendingUploads',
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
	'inboxSlaPolicies',
	'clarificationAskLog',
	'clarificationMemory',
	'agentShadowDecisions',
	'agentShadowScorecard',
	'contentScanResults',

	// Conversation parents (after their leaves)
	'unifiedMessages',
	'threadPresence', // ephemeral viewer/replier signals — clear before their threads
	'threadReads', // per-user read markers — clear before their threads
	'threadNoteMentions', // note mention rows — before their notes
	'threadNotes', // internal team notes — clear before their threads
	'inboxFollowUps', // team follow-up bodies — clear before their threads
	'threadCatchUps', // Answer mode catch-up cards (team and Postbox) — before both thread tables
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
	'mailThreadVisits',
	'todayStates',
	'todayThreadSummaries',
	'bookings',
	'bookingMeetingTypes',
	'bookingProfiles',
	'mailForwarding',
	'mailVacationResponders',
	'mailVacationLog',
	'mailAuditLog',
	'mailAuthFailures',
	'externalMailFolderSync',
	'externalMailAccessTokens',
	'externalMailRemoteOps',
	'externalMailAccounts',
	'externalMailOAuthStates',
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
	'mailboxUsage',
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
	'audienceCountJobs',
	'campaignStatShards',
	'sendTimeHistogramShards',
	'campaignSenders',
	'sendDailyStats',

	// Campaign + template parents
	'campaigns',
	// Version snapshots before the templates they belong to.
	'emailCoeditNotices', // co-editing notices, presence and live drafts — before their emails
	'emailEditorPresence',
	'emailCoeditSessions',
	'emailTemplateVersions',
	'emailTemplates',
	'transactionalEmails',
	'emailBlocks',

	// Contact cascade — delegates; sweeps 5 child tables that aren't
	// standalone steps (contactTopics, contactPropertyValues,
	// contactActivities, contactIdentities, contactRelationships)
	'contactErasureJobs', // erasure progress rows point at the contacts below
	'contacts',

	// Orphan sweeps: the contacts step delegates these per contact, but rows
	// whose parent is already gone would survive — sweep the remainder.
	'contactTopics',
	'contactPropertyValues',
	'contactActivities',
	'contactIdentities',
	'contactRelationships',

	// Per-topic sunset-policy overrides — configuration rows with no
	// parent among the contact tables.
	'sunsetPolicies',

	// Independent definitions (no parent/child among themselves)
	'contactPropertyDeletionJobs', // deletion progress rows point at the properties below
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
	'dmarcReportRecords',
	'dmarcReports',
	'domains',
	'sendingDomainMtaIdentities',
	'sendingDomainSesIdentities',
	'sendingDomainRelayIdentities',

	// Chat (children before parents)
	'chatMentions',
	'chatMessages',
	'chatRoomMembers',
	'chatRooms',

	// AI assistant (children first), draft stream buffers, Answer mode ask sessions
	'aiMessages',
	'aiConversations',
	'aiDraftStreams',
	'answerAskSessions',

	// The AI provider choice and the encrypted API keys entered for this
	// workspace (#1101). Nothing above reads it; the deployment's LLM_* env
	// fallback is what any later AI call resolves.
	'aiProviderConfig',

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

	// The rows split off instanceSettings (plan 2.4), then the terminal
	// singleton row that owned the org's existence
	'featureFlagSettings',
	'instanceCounters',
	'instanceSettings',
] as const;
