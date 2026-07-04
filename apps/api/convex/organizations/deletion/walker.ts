/**
 * Organization deletion walker — owns the ordered cascade list, the
 * typed dispatch registry, the entry-point (`start`) called by
 * `organizationSettings.remove`, and the self-scheduled `runStep` hop.
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
	type OrganizationDeletionStepModule,
	type OrganizationDeletionTable,
} from './steps/_common';

// Distinct steps with per-row side effects the generic sweep can't express:
// storage-blob purges (mediaAssets / semanticFiles / mailMessages /
// mailDrafts / transactionalSends) and delegated cascades (contacts →
// permanentlyDeleteContactWithRelations, domains → sendingDomainLifecycle.remove).
// Every other table is a pure `take + delete` sweep, expressed inline below via
// makeSweepStep — no per-table file needed.
import { mediaAssetsStep } from './steps/mediaAssets';
import { semanticFilesStep } from './steps/semanticFiles';
import { mailMessagesStep } from './steps/mailMessages';
import { mailDraftsStep } from './steps/mailDrafts';
import { transactionalSendsStep } from './steps/transactionalSends';
import { contactsStep } from './steps/contacts';
import { domainsStep } from './steps/domains';
import { makeSweepStep } from './steps/sweep';

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
	'askEagernessSettings',
	'clarificationAskLog',
	'agentShadowDecisions',
	'agentShadowScorecard',
	'contentScanResults',

	// Conversation parents (after their leaves)
	'unifiedMessages',
	'inboundMessages',
	'conversationThreads',
	'channelConfigs',

	// Postbox sidecar family (children + logs before mailboxes)
	'mailThreads',
	'mailContacts',
	'mailSenderCategoryOverrides',
	'mailForwarding',
	'mailVacationResponders',
	'mailVacationLog',
	'mailAuditLog',
	'mailAuthFailures',
	'externalMailFolderSync',
	'externalMailAccounts',
	'mailboxMigrations',
	'pendingMailboxes',

	// Postbox configuration before mailboxes
	'mailAliases',
	'mailFolders',
	'mailLabels',
	'mailVoiceProfiles',
	'mailFilters',
	'mailSignatures',
	'mailSnippets',
	'mailUserSettings',
	'mailAppPasswords',
	'mailboxes',

	// Webhook / form children before parents
	'webhookDeliveryLogs',
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
	'sendDailyStats',

	// Campaign + template parents
	'campaigns',
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

	// Domain stack — provider identities + reputation before domains,
	// which delegates for SES / MTA-side cleanup
	'sendingDomainMtaIdentities',
	'sendingDomainSesIdentities',
	'trackingDomains',
	'sendingReputation',
	'providerHealth',
	'providerRoutes',
	'domains',

	// Chat (children before parents)
	'chatMentions',
	'chatMessages',
	'chatRoomMembers',
	'chatRooms',

	// AI assistant (children before parent)
	'aiMessages',
	'aiConversations',

	// Independent feature state
	'coalesceBatches',
	'visualizations',
	'dashboardLayouts',
	'shareLinks',
	'integrationImports',
	'codeWorkTasks',

	// UI / onboarding state
	'onboardingProgress',

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
	mailFilters: makeSweepStep('mailFilters'),
	mailSignatures: makeSweepStep('mailSignatures'),
	mailSnippets: makeSweepStep('mailSnippets'),
	mailUserSettings: makeSweepStep('mailUserSettings'),
	mailAppPasswords: makeSweepStep('mailAppPasswords'),
	mailboxes: makeSweepStep('mailboxes'),
	webhookDeliveryLogs: makeSweepStep('webhookDeliveryLogs'),
	webhooks: makeSweepStep('webhooks'),
	formSubmissions: makeSweepStep('formSubmissions'),
	formEndpoints: makeSweepStep('formEndpoints'),
	automationStepRuns: makeSweepStep('automationStepRuns'),
	automationRuns: makeSweepStep('automationRuns'),
	automationSteps: makeSweepStep('automationSteps'),
	automations: makeSweepStep('automations'),
	campaigns: makeSweepStep('campaigns'),
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
	trackingDomains: makeSweepStep('trackingDomains'),
	sendingReputation: makeSweepStep('sendingReputation'),
	providerHealth: makeSweepStep('providerHealth'),
	providerRoutes: makeSweepStep('providerRoutes'),
	domains: domainsStep,
	onboardingProgress: makeSweepStep('onboardingProgress'),
	auditLogs: makeSweepStep('auditLogs'),
	instanceSettings: makeSweepStep('instanceSettings'),
	unifiedMessages: makeSweepStep('unifiedMessages'),
	channelConfigs: makeSweepStep('channelConfigs'),
	agentMetrics: makeSweepStep('agentMetrics'),
	llmUsageEvents: makeSweepStep('llmUsageEvents'),
	agentCircuitBreakers: makeSweepStep('agentCircuitBreakers'),
	agentConfig: makeSweepStep('agentConfig'),
	autonomyFeedback: makeSweepStep('autonomyFeedback'),
	autonomyRules: makeSweepStep('autonomyRules'),
	autonomySuggestions: makeSweepStep('autonomySuggestions'),
	askEagernessSettings: makeSweepStep('askEagernessSettings'),
	clarificationAskLog: makeSweepStep('clarificationAskLog'),
	agentShadowDecisions: makeSweepStep('agentShadowDecisions'),
	agentShadowScorecard: makeSweepStep('agentShadowScorecard'),
	mailThreads: makeSweepStep('mailThreads'),
	mailContacts: makeSweepStep('mailContacts'),
	mailSenderCategoryOverrides: makeSweepStep('mailSenderCategoryOverrides'),
	mailForwarding: makeSweepStep('mailForwarding'),
	mailVacationResponders: makeSweepStep('mailVacationResponders'),
	mailVacationLog: makeSweepStep('mailVacationLog'),
	mailAuditLog: makeSweepStep('mailAuditLog'),
	mailAuthFailures: makeSweepStep('mailAuthFailures'),
	mailboxMigrations: makeSweepStep('mailboxMigrations'),
	externalMailFolderSync: makeSweepStep('externalMailFolderSync'),
	externalMailAccounts: makeSweepStep('externalMailAccounts'),
	pendingMailboxes: makeSweepStep('pendingMailboxes'),
	webhookPayloads: makeSweepStep('webhookPayloads'),
	automationStatShards: makeSweepStep('automationStatShards'),
	campaignSendJobs: makeSweepStep('campaignSendJobs'),
	campaignStatShards: makeSweepStep('campaignStatShards'),
	sendDailyStats: makeSweepStep('sendDailyStats'),
	contactTopics: makeSweepStep('contactTopics'),
	contactPropertyValues: makeSweepStep('contactPropertyValues'),
	contactActivities: makeSweepStep('contactActivities'),
	contactIdentities: makeSweepStep('contactIdentities'),
	contactRelationships: makeSweepStep('contactRelationships'),
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
	coalesceBatches: makeSweepStep('coalesceBatches'),
	visualizations: makeSweepStep('visualizations'),
	dashboardLayouts: makeSweepStep('dashboardLayouts'),
	shareLinks: makeSweepStep('shareLinks'),
	integrationImports: makeSweepStep('integrationImports'),
	codeWorkTasks: makeSweepStep('codeWorkTasks'),
} as const satisfies {
	readonly [K in OrganizationDeletionTable]: OrganizationDeletionStepModule<K>;
};

/**
 * Returns the next table after `table` in `STEPS`, or `null` if `table`
 * is the terminal step. The terminal-discipline is encoded here once
 * — pre-deepening, each switch case asserted `getNextStep(step)!`
 * non-null at the boundary and relied on the terminal case's earlier
 * `return` to dodge a null-deref. Drift #6.
 */
export function nextTable(
	table: OrganizationDeletionTable,
): OrganizationDeletionTable | null {
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
		await ctx.scheduler.runAfter(
			0,
			internal.organizations.deletion.walker.runStep,
			{ table: STEPS[0] },
		);
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
			await ctx.scheduler.runAfter(
				0,
				internal.organizations.deletion.walker.runStep,
				{ table },
			);
			return;
		}

		const next = nextTable(table);
		if (next === null) return;

		await ctx.scheduler.runAfter(
			0,
			internal.organizations.deletion.walker.runStep,
			{ table: next },
		);
	},
});
