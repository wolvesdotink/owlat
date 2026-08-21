/**
 * Organization deletion walker — owns the ordered cascade list, the
 * entry-point (`start`) called by `organizationSettings.remove`, and the
 * self-scheduled `runStep` hop. The typed dispatch registry it dispatches
 * through lives in the `registry.ts` sibling and is re-exported here, so
 * `ORGANIZATION_DELETION_STEPS` stays reachable beside the cascade that
 * orders it.
 *
 * Pattern mirrors the **Step walker** (ADR-0004, automations), the
 * **Agent walker** (inbox agent pipeline), and the **IMAP command
 * walker** (ADR-0016): typed dispatch table, pure per-kind modules,
 * walker owns lifecycle plumbing.
 *
 * See docs/adr/0025-organization-deletion-module-family.md.
 */

import { internalMutation } from '../../_generated/server';
import { internal } from '../../_generated/api';
import {
	organizationDeletionTableValidator,
	type OrganizationDeletionTable,
} from './steps/_common';
import { ORGANIZATION_DELETION_STEPS } from './registry';

export { ORGANIZATION_DELETION_STEPS } from './registry';

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
	'mailMessages',
	'mailDrafts',
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
	'mailSignatures',
	'mailSnippets',
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
	// OSTR: evidence bundles hold this org's inbound mail verbatim.
	'ostrEvidence',
	'ostrReportQueue',
	'ostrBatchCommitments',
	'ostrObserverState',

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
 * Returns the next table after `table` in `STEPS`, or `null` if `table`
 * is the terminal step. The terminal-discipline is encoded here once
 * — pre-deepening, each switch case asserted `getNextStep(step)!`
 * non-null at the boundary and relied on the terminal case's earlier
 * `return` to dodge a null-deref. Drift #6.
 */
export function nextTable(table: OrganizationDeletionTable): OrganizationDeletionTable | null {
	const idx = STEPS.indexOf(table);
	if (idx === -1 || idx === STEPS.length - 1) return null;
	return STEPS[idx + 1] ?? null;
}

/**
 * Entry point — called by `organizationSettings.remove`. Schedules the
 * first step. Zero-arg: the wipe operates on the single-org-per-
 * deployment data plane, so there's nothing to scope to.
 */
export const start = internalMutation({
	args: {},
	handler: async (ctx) => {
		await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.runStep, {
			table: STEPS[0],
		});
	},
});

/**
 * Self-scheduled walker hop. Runs one batch via the dispatch registry;
 * re-fires the same step while `hasMore`; advances to the next step
 * when `hasMore` flips to false; terminates when there's no next step.
 *
 * The `table` arg is validated against the literal union — a typo is
 * a compile-time + boot-time error, not a silent runtime no-op.
 * Drift #5.
 */
export const runStep = internalMutation({
	args: { table: organizationDeletionTableValidator },
	handler: async (ctx, { table }) => {
		const mod = ORGANIZATION_DELETION_STEPS[table];
		const { hasMore } = await mod.deleteBatch(ctx);

		if (hasMore) {
			await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.runStep, { table });
			return;
		}

		const next = nextTable(table);
		if (next === null) return;

		await ctx.scheduler.runAfter(0, internal.workspaces.deletion.walker.runStep, {
			table: next,
		});
	},
});
