/**
 * PREVIOUS-RELEASE ENTRY POINTS — kept for one release because the previous
 * release reaches them by path during the deploy window: its actions still
 * running when the new functions go live, and scheduler jobs it queued before
 * the deploy (`CONVENTIONS.md`, "Old clients and workers against new
 * functions"). Nothing in this release calls them, which is the point. Each
 * line names why it stays; the next release deletes the entry and its line.
 * `check-entry-wiring.ts` holds it exact in both directions, like its
 * UNREACHED_ENTRIES ledger (`entryWiringUnreached.ts`). Kept in its own file so the release that
 * deletes these entries edits data, not the walk.
 */
export const PREVIOUS_RELEASE_ENTRIES: Readonly<Record<string, string>> = {
	// The whole-chain, whole-row history; the web now pages files/history.ts.
	// Removal waits for an inventory of API, SDK and plugin callers too.
	'semanticFiles.ts#getVersionHistory':
		'the previous file detail page, in tabs opened before the deploy',
	// Whole-row file lists; the web now reads compact cards (files/cards.ts).
	// Removal waits for an inventory of API, SDK and plugin callers too.
	'semanticFiles.ts#list':
		'the previous Files page and Answer file picker, in tabs opened before the deploy',
	'semanticFiles.ts#search':
		'the previous Files page and Answer file picker, in tabs opened before the deploy',
	'semanticFiles.ts#listByContact':
		'the previous contact Files tab and Team Answer attach menu, in tabs opened before the deploy',
	'campaigns/sendQueries.ts#storeContentScanResult': 'old campaign send preparations mid-run',
	'campaigns/archiveQueries.ts#setArchiveSnapshot': 'old campaign send preparations mid-run',
	'emailTemplates/versions.ts#captureForSend': 'old campaign send preparations mid-run',
	// A send-walker page now commits once (campaigns/walkerCommit.ts).
	'delivery/sends.ts#createBatch': 'old campaign send-walker hops mid-page',
	'campaigns/sendQueries.ts#incrementDailySendCountInternal':
		'old campaign send-walker hops mid-page',
	'campaigns/sendJob.ts#advanceSendJob': 'old campaign send-walker hops mid-page',
	// The A/B winner phase now commits once (campaigns/walkerCommit.ts).
	'campaigns/sendQueries.ts#freezeCampaignAudience': 'old A/B winner phases mid-run',
	// The test sends now commit once (campaigns/testSendCommit.ts).
	'campaigns/senders.ts#seedDefaultSender': 'old test sends mid-run',
	'campaigns/senders.ts#checkSenderAllowed': 'old test sends mid-run',
	'delivery/enqueueTestSend.ts#enqueueTestSend': 'old test sends mid-run',
	'campaigns/sendJob.ts#createSendJob':
		'old campaign send preparations and A/B winner phases mid-run',
	// The delivery actions below now commit once; remove after release 0.6.17.
	'delivery/alignmentPreflight.ts#recordAlignmentResult': 'old alignment sweeps mid-run',
	'delivery/warmingSync.ts#upsertWarmingState': 'old warming syncs mid-run',
	'delivery/deliverabilityRouting.ts#applySnapshot': 'old warming syncs mid-run',
	// The archive import runner now commits a pass with mail/archiveImport.ts `commitPass`.
	'mail/archiveImport.ts#recordProgress': 'old archive import passes mid-run',
	// The indexing sweep now commits a chunk with mail/migrationIndexingCommit.ts `commitIndexChunk`.
	'mail/migrationIndexing.ts#patchIndexProgress': 'old mailbox indexing chunks mid-run',
	'mail/migrationIndexing.ts#finalizeMigration': 'old mailbox indexing chunks mid-run',
	// The message backfill now commits a chunk with knowledge/messageBackfillChunk.ts `commitChunk`.
	'knowledge/messageBackfill.ts#patchProgress': 'old message backfill chunks mid-run',
	'knowledge/messageBackfill.ts#finalizeJob': 'old message backfill chunks mid-run',
	// The re-embed actions now commit through aiRouting/embeddingReembedCommit.ts.
	'aiRouting/embeddingReembedJobs.ts#startLocalReembed': 'old re-embed kickoffs mid-run',
	'aiRouting/embeddingReembedJobs.ts#reembedCommit': 'old re-embed batches mid-run',
	'aiRouting/embeddingReembedJobs.ts#startReembedJob': 'old admin re-embed starts mid-run',
	'aiRouting/embeddingSpaces.ts#ensureConfigured': 'old re-embed kickoffs and admin starts mid-run',
	// The expected-attachment copy now lands in one commit (`bindCopy`).
	'mail/draftExpectedAttachments.ts#stageCopy': 'old draft attachment fulfils mid-copy',
	'mail/draftExpectedAttachments.ts#bindExpected': 'old draft attachment fulfils mid-copy',
	'mail/draftExpectedAttachments.ts#dropCopy': 'old draft attachment fulfils mid-copy',
	// Answer mode's start and answer now commit through mail/ai/composeDraftCommit.ts.
	'mail/ai/composeDraftStore.ts#replaceSession': 'old Answer mode starts mid-run',
	'mail/ai/composeDraftStore.ts#captureSessionAnswers': 'old Answer mode answers mid-run',
	'mail/ai/composeDraftStore.ts#setDraftFollowUp': 'old Answer mode starts and answers mid-run',
	// The agent walker now holds for budget inside agent/walkerCommit.ts `beginStep`,
	// `commitStep` and `commitResumeDraft`.
	'aiRouting/teamBudgetHold.ts#holdIfOverBudget':
		'old agent walker steps and draft resumes mid-run',
	// The batch poller now settles an item with aiRouting/batchItems.ts `settleItem`.
	'aiRouting/batchItems.ts#postponePoll': 'old batch polls mid-run',
	'aiRouting/batchItems.ts#completeItem': 'old batch polls mid-run',
	'aiRouting/batchItems.ts#failItem': 'old batch polls mid-run',
	'aiRouting/batchItems.ts#abandonItem': 'old batch polls mid-run',
	// A walker step module now returns its outputs and agent/walkerCommit.ts
	// `commitStep` applies them (agent/stepWrites.ts). Remove after release N+1.
	'inbox/stepOutputs.ts#recordContextTier': 'old agent walker steps mid-run',
	'inbox/stepOutputs.ts#recordAgentDecision': 'old agent walker steps mid-run',
	'inbox/stepOutputs.ts#recordDraftOutput': 'old agent walker steps mid-run',
	'inbox/stepOutputs.ts#recordSecurityScan': 'old agent walker steps mid-run',
	'agent/shadowScorecard.ts#recordShadowDecision': 'old agent walker steps mid-run',
	'mail/interpret/planGate.ts#recordShadow': 'old agent walker steps mid-run',
	// The plugin relay identity call now commits once through
	// domains/pluginRelayMutations.ts `commitIdentityCall` / `commitDeniedCall`.
	'domains/pluginRelayMutations.ts#recordCheck': 'old plugin relay identity calls mid-run',
	'domains/pluginRelayMutations.ts#recordCheckFailure': 'old plugin relay identity calls mid-run',
	'domains/pluginRelayMutations.ts#deferDeniedCheck': 'old plugin relay identity calls mid-run',
	'plugins/sendTransportDomainIdentityAuthorization.ts#authorizeIdentityCall':
		'old plugin relay identity calls mid-run',
	'plugins/sendTransportDomainIdentityAuthorization.ts#recordOutcome':
		'old plugin relay identity calls mid-run',
	// Sending-domain registration now lands its outcome and return-path repair in
	// domains/providers/registerCommit.ts `commitRegistration`.
	'domains/lifecycleReturnPath.ts#reconcileReturnPathAfterRegistration':
		'old sending-domain registrations mid-run',
	// System & updates now reads maintenance/workerRegistry.ts `getForAdmin`.
	'mail/imap/serverRegistry.ts#getForAdmin':
		'the previous IMAP servers card on System & updates, in tabs opened before the deploy',
	// push/send.deliver now plans in push/delivery.ts and holds quiet devices
	// in its commit after the pushes. Remove after release N+1.
	'push/dispatch.ts#prepareDelivery': 'old push deliveries mid-run',
	// `filterCompile.compile` now starts through startCompile, which schedules
	// the compile. Remove after release N+1.
	'mail/filterCompileStore.ts#startDraft': 'old rule compiles mid-run',
	// The channel dispatch and the delivery poll now commit through
	// channels/outboundCommit.ts. Remove after release N+1.
	'unifiedMessages.ts#recordOutbound': 'old channel dispatches mid-run',
	'unifiedMessages.ts#updateDeliveryStatus': 'old channel delivery polls mid-run',
	// `/seed/admin` now writes through one commit (auth/seedAdminCommit.ts); the
	// latch claim keeps an old and a new seed from both running.
	'workspaces/settings.ts#createInternal': 'old /seed/admin requests mid-run',
	'workspaces/settings.ts#claimAdminSeedInternal': 'old /seed/admin requests mid-run',
	'auth/userProfiles.ts#createInternal': 'old /seed/admin requests mid-run',
	'workspaces/featureFlags.ts#setAllInternal': 'old /seed/admin requests mid-run',
	// An export row now stages through one commit (`stageArtifact`).
	'auth/accountExportArtifacts.ts#acquireArtifactLease': 'old account export pages mid-run',
	'auth/accountExportArtifacts.ts#registerArtifact': 'old account export pages mid-run',
	// The agent metrics rollup now commits once (agent/healthRollup.ts `commitRollup`);
	// remove after release 0.6.17.
	'agentHealth.ts#recordMetrics': 'old agent metrics rollups mid-run',
	'agentHealth.ts#updateCircuitBreaker': 'old agent metrics rollups mid-run',
	// The weekly threshold cron now commits once (autonomy/feedback.ts
	// `commitThresholdAdjustments`); remove after release 0.6.17.
	'autonomyFeedback.ts#updateThreshold': 'old threshold adjustments mid-run',
	'autonomySuggestions.ts#recordGraduationSuggestion': 'old threshold adjustments mid-run',
	'autonomySuggestions.ts#clearGraduationSuggestion': 'old threshold adjustments mid-run',
	// The desktop release refresh now commits once (desktop/refreshCommit.ts
	// `commitRefresh`); remove after release 0.6.17.
	'desktop/updates.ts#cacheRelease': 'old desktop release refreshes mid-run',
	'desktop/updates.ts#recordCheck': 'old desktop release refreshes mid-run',
	'desktop/updates.ts#pruneReleases': 'old desktop release refreshes mid-run',
	// Share links moved to shareLinks/links.ts and shareLinks/queries.ts; remove
	// after release 0.6.17.
	'shareLinks.ts#createShareLink':
		'the previous share links popover, in tabs opened before the deploy',
	'shareLinks.ts#revokeShareLink':
		'the previous share links popover, in tabs opened before the deploy',
	'shareLinks.ts#listShareLinks':
		'the previous share links popover, in tabs opened before the deploy',
	'shareLinkQueries.ts#getShareLinkByToken': 'old /share/{token} requests mid-run',
	// The autonomy modules moved to autonomy/policy.ts, autonomy/feedback.ts,
	// autonomy/suggestions.ts and autonomy/outcome.ts; remove after release 0.6.17.
	'autonomy.ts#listRules': 'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomy.ts#upsertRule': 'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomy.ts#setSenderAutonomy':
		'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomy.ts#deleteRule': 'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomy.ts#checkPermissionInternal': 'old agent route steps mid-run',
	'autonomy.ts#incrementDailyCount': 'old agent route steps mid-run',
	'autonomy.ts#listRulesInternal': 'old threshold adjustments mid-run',
	'autonomy.ts#resetDailyCounts': 'a daily-count reset the previous cron queued',
	'autonomyFeedback.ts#getFeedbackStats':
		'the previous AI replies page, in tabs opened before the deploy',
	'autonomyFeedback.ts#getRecentFeedbackInternal': 'old threshold adjustments mid-run',
	'autonomyFeedback.ts#getFeedbackCountsInternal': 'old agent metrics rollups mid-run',
	'autonomyFeedback.ts#recordFeedback': 'old reviewer decisions and outcome records by path',
	'autonomyFeedback.ts#adjustThresholds': 'a threshold adjustment the previous cron queued',
	'autonomySuggestions.ts#listGraduationSuggestions':
		'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomySuggestions.ts#acceptGraduationSuggestion':
		'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomyOutcome.ts#listAutoDemotions':
		'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomyOutcome.ts#acknowledgeAutoDemotion':
		'the previous autonomy settings page, in tabs opened before the deploy',
	'autonomyOutcome.ts#getReplyOutcomeContext': 'old reply outcome classifications mid-run',
	'autonomyOutcome.ts#recordOutcomeFeedback':
		'old reply outcome classifications mid-run, and outcome records the previous release queued',
	// The agent config and health modules moved to agent/configMutations.ts,
	// agent/health.ts and agent/healthRollup.ts; remove after release 0.6.17.
	'agentConfigMutations.ts#getConfig':
		'the previous AI replies page, in tabs opened before the deploy',
	'agentConfigMutations.ts#updateConfig':
		'the previous AI replies page, in tabs opened before the deploy',
	'agentConfigMutations.ts#setReplyMode':
		'the previous AI replies page, in tabs opened before the deploy',
	'agentHealth.ts#getDashboardMetrics':
		'the previous agent health page, in tabs opened before the deploy',
	'agentHealth.ts#getMetricHistory':
		'the previous agent health page, in tabs opened before the deploy',
	'agentHealth.ts#getCostByStep':
		'the previous cost-by-step card, in tabs opened before the deploy',
	'agentHealth.ts#getAccuracyTrend':
		'the previous accuracy trend card, in tabs opened before the deploy',
	'agentHealth.ts#getCircuitBreakersInternal': 'old agent route steps mid-run',
	'agentHealth.ts#rollupMetrics': 'a metrics rollup the previous cron queued',
	'agentHealth.ts#getRecentActions': 'old agent metrics rollups mid-run',
	'agentHealth.ts#getPendingCount': 'old agent metrics rollups mid-run',
	// The AI provider config, translate, Quick Query, visualization and global
	// search modules moved to aiRouting/providerConfig.ts,
	// aiRouting/providerConfigActions.ts, emailTemplates/translate.ts,
	// assistant/quickQuery.ts, assistant/quickQueryGate.ts,
	// analytics/visualizationAgent.ts, analytics/visualizationAgentActions.ts and
	// search/global.ts; remove after release 0.6.17.
	'aiProviderConfig.ts#getConfig':
		'the previous AI provider settings page, in tabs opened before the deploy',
	'aiProviderConfig.ts#removeConfig':
		'the previous AI provider settings page, in tabs opened before the deploy',
	'aiProviderConfig.ts#_persistConfig': 'old AI provider saves mid-run',
	'aiProviderConfig.ts#_getConfigRow':
		'old AI provider connection tests, model listings and model resolutions mid-run',
	'aiProviderConfigActions.ts#saveConfig':
		'the previous AI provider settings page, in tabs opened before the deploy',
	'aiProviderConfigActions.ts#testConnection':
		'the previous AI provider settings page, in tabs opened before the deploy',
	'aiProviderConfigActions.ts#listModels':
		'the previous AI provider settings page, in tabs opened before the deploy',
	'aiProviderConfigActions.ts#_decryptSecretEnvelope': 'old model resolutions mid-run',
	'translate.ts#translateBatch':
		'the previous template translation editors and Postbox reader, in tabs opened before the deploy',
	'quickQuery.ts#ask': 'the previous command palette Ask mode, in tabs opened before the deploy',
	'quickQueryGate.ts#assertKnowledgeReadAccess': 'old Quick Query asks mid-run',
	'visualizationAgent.ts#list':
		'the previous visualizations page, in tabs opened before the deploy',
	'visualizationAgent.ts#listPinned':
		'the previous pinned visualizations card, in tabs opened before the deploy',
	'visualizationAgent.ts#createFromPrompt':
		'the previous visualizations page, in tabs opened before the deploy',
	'visualizationAgent.ts#regenerate':
		'the previous visualizations page, in tabs opened before the deploy',
	'visualizationAgent.ts#togglePin':
		'the previous visualizations page, in tabs opened before the deploy',
	'visualizationAgent.ts#remove':
		'the previous visualizations page, in tabs opened before the deploy',
	'visualizationAgent.ts#updateGenerated': 'old visualization generations mid-run',
	'visualizationAgent.ts#dataEmailDelivery30d': 'old visualization generations mid-run',
	'visualizationAgent.ts#dataAgentHealth': 'old visualization generations mid-run',
	'visualizationAgent.ts#dataContactGrowth': 'old visualization generations mid-run',
	'visualizationAgent.ts#dataCampaignPerformance': 'old visualization generations mid-run',
	'visualizationAgentActions.ts#generate':
		'visualization generations the previous release scheduled',
	'globalSearch.ts#search': 'the previous command palette, in tabs opened before the deploy',
	'globalSearch.ts#searchInternal': 'old assistant runs mid-run',
	// The Files library and its processing pipeline moved to files/library.ts,
	// files/pipeline.ts and files/processing.ts; remove after release 0.6.17.
	'semanticFiles.ts#get': 'the previous file detail page, in tabs opened before the deploy',
	'semanticFiles.ts#create': 'the previous Files upload dialog, in tabs opened before the deploy',
	'semanticFiles.ts#update':
		'the previous Files page and file detail page, in tabs opened before the deploy',
	'semanticFiles.ts#remove':
		'the previous Files page and file detail page, in tabs opened before the deploy',
	'semanticFiles.ts#ingest': 'old inbound attachment captures mid-run',
	'semanticFiles.ts#getInternal': 'old file processing runs and knowledge extractions mid-run',
	'semanticFiles.ts#getProcessingContext': 'old file processing runs mid-run',
	'semanticFiles.ts#updateProcessedMetadata': 'old file processing runs mid-run',
	'semanticFiles.ts#getByIds': 'old file searches mid-run',
	'semanticFiles.ts#ftsRankedFileIds': 'old file searches mid-run',
	'semanticFiles.ts#backfillUnprocessed': 'a file backfill the previous cron queued',
	'semanticFiles.ts#reprocessAfterAiConfigured':
		'a file reprocessing pass the previous release scheduled when an AI provider was saved',
	'semanticFileProcessing.ts#processFile':
		'file processing runs the previous release scheduled (uploads, captures, backfills, budget deferrals, batch continuations)',
	'semanticFileProcessing.ts#semanticSearch':
		'old agent context retrievals, attachment suggestions, assistant runs and Quick Query asks mid-run',
	// System mail, updates, backups, audit log reads and storage URLs moved to
	// maintenance/systemMail.ts, maintenance/updates.ts, maintenance/releaseCheck.ts,
	// maintenance/backups.ts, auditActions/logs.ts and storage/files.ts; remove
	// after release 0.6.17.
	'systemMail.ts#sendSystemEmail':
		'old auth and invitation hooks, double opt-in, account-deletion, checklist loopback and delivery status sends mid-run',
	'systemMail.ts#trySendSystemEmail': 'old deliverability checklist alerts mid-run',
	'systemUpdates.ts#recordUpdateStart':
		'the previous /api/system/update route, until its container is replaced',
	'systemUpdates.ts#recordUpdateFinish':
		'the previous /api/system/update route and System page, in tabs opened before the deploy',
	'systemUpdates.ts#withdrawUpdateStart':
		'the previous /api/system/update route, until its container is replaced',
	'systemUpdates.ts#getLatestRelease': 'the previous System page, in tabs opened before the deploy',
	'systemUpdates.ts#getUnfinishedUpdate':
		'the previous System page, in tabs opened before the deploy',
	'systemUpdates.ts#recordUpdateActivity':
		'the previous System page following a rollout, in tabs opened before the deploy',
	'systemUpdates.ts#getRolloutActivity': 'the previous app shell, in tabs opened before the deploy',
	'systemUpdates.ts#listUpdateHistory':
		'the previous update history card, in tabs opened before the deploy',
	'systemUpdatesReleaseCheck.ts#checkForUpdates':
		'the previous System page, in tabs opened before the deploy',
	'systemUpdatesReleaseCheck.ts#getLatestCheckInternal': 'old update checks mid-run',
	'systemUpdatesReleaseCheck.ts#cacheLatestRelease': 'old update checks mid-run',
	'systemUpdatesReleaseCheck.ts#cacheCheckFailure': 'old update checks mid-run',
	'backups.ts#getBackupState':
		'the previous Backups page and Getting Started card, in tabs opened before the deploy',
	'backups.ts#setScheduleEnabled': 'the previous Backups page, in tabs opened before the deploy',
	'backups.ts#logManualRun': 'the previous Backups page, in tabs opened before the deploy',
	'auditLogs.ts#list': 'the previous audit page, in tabs opened before the deploy',
	'auditLogs.ts#getStats': 'the previous audit page, in tabs opened before the deploy',
	'auditLogs.ts#getActiveUsers': 'the previous audit page, in tabs opened before the deploy',
	'storage.ts#generateUploadUrl':
		'the previous upload surfaces (editor images, media library, attachments, Files, mail compose, archive import, workspace logo), in tabs opened before the deploy',
	'storage.ts#getUrl':
		'the previous editor image upload, media picker and attachment panel, in tabs opened before the deploy',
	// Segments and the blocklist moved to segments/segments.ts,
	// blockedEmails/blocklist.ts and blockedEmails/events.ts; remove after
	// release 0.6.17.
	'segments.ts#get': 'the previous segment detail page, in tabs opened before the deploy',
	'segments.ts#list':
		'the previous segment list and campaign audience picker, in tabs opened before the deploy',
	'segments.ts#listMembers': 'the previous segment detail page, in tabs opened before the deploy',
	'segments.ts#listMembersForExport':
		'the previous segment detail page export, in tabs opened before the deploy',
	'segments.ts#create': 'the previous segment builder, in tabs opened before the deploy',
	'segments.ts#update': 'the previous segment builder, in tabs opened before the deploy',
	'segments.ts#remove': 'the previous segment builder, in tabs opened before the deploy',
	'segments.ts#countMatchingContacts':
		'the previous segment builder audience estimate, in tabs opened before the deploy',
	'segments.ts#getInternal': 'old segment member exports mid-run',
	'segments.ts#listMembersPage': 'old segment member exports mid-run',
	'segments.ts#countMatchingContactsPage': 'old segment builder audience estimates mid-run',
	'blockedEmails.ts#listByTeam': 'the previous Suppressions page, in tabs opened before the deploy',
	'blockedEmails.ts#listProviderProvenance':
		'the previous Suppressions page, in tabs opened before the deploy',
	'blockedEmails.ts#getByEmail': 'the previous contact page, in tabs opened before the deploy',
	'blockedEmails.ts#add': 'the previous Suppressions page, in tabs opened before the deploy',
	'blockedEmails.ts#remove':
		'the previous Suppressions and contact pages, in tabs opened before the deploy',
	'blockedEmails.ts#bulkAdd':
		'the previous Suppressions page import, in tabs opened before the deploy',
	'blockedEmails.ts#getCountsByReason':
		'the previous Suppressions page and delivery overview, in tabs opened before the deploy',
	'blockedEmails.ts#addFromEvent':
		'old complaint and provider suppression webhook runs and suppression imports mid-run',
};
