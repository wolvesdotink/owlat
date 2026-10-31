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
	// The agent metrics rollup now commits once (agentHealth.ts `commitRollup`);
	// remove after release 0.6.17.
	'agentHealth.ts#recordMetrics': 'old agent metrics rollups mid-run',
	'agentHealth.ts#updateCircuitBreaker': 'old agent metrics rollups mid-run',
	// The weekly threshold cron now commits once (autonomyFeedback.ts
	// `commitThresholdAdjustments`); remove after release 0.6.17.
	'autonomyFeedback.ts#updateThreshold': 'old threshold adjustments mid-run',
	'autonomySuggestions.ts#recordGraduationSuggestion': 'old threshold adjustments mid-run',
	'autonomySuggestions.ts#clearGraduationSuggestion': 'old threshold adjustments mid-run',
};
