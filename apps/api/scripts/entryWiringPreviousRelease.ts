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
	'campaigns/sendJob.ts#createSendJob':
		'old campaign send preparations and A/B winner phases mid-run',
	// The expected-attachment copy now lands in one commit (`bindCopy`).
	'mail/draftExpectedAttachments.ts#stageCopy': 'old draft attachment fulfils mid-copy',
	'mail/draftExpectedAttachments.ts#bindExpected': 'old draft attachment fulfils mid-copy',
	'mail/draftExpectedAttachments.ts#dropCopy': 'old draft attachment fulfils mid-copy',
	// Answer mode's start and answer now commit through mail/ai/composeDraftCommit.ts.
	'mail/ai/composeDraftStore.ts#replaceSession': 'old Answer mode starts mid-run',
	'mail/ai/composeDraftStore.ts#captureSessionAnswers': 'old Answer mode answers mid-run',
	'mail/ai/composeDraftStore.ts#setDraftFollowUp': 'old Answer mode starts and answers mid-run',
	// System & updates now reads maintenance/workerRegistry.ts `getForAdmin`.
	'mail/imap/serverRegistry.ts#getForAdmin':
		'the previous IMAP servers card on System & updates, in tabs opened before the deploy',
};
