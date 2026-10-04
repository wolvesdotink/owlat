import type { TableNames } from '../_generated/dataModel';

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
 * Tables are ordered children-before-parents. Convex deletes are independent
 * (there is no enforced referential integrity), so the ordering is defensive
 * hygiene rather than a correctness requirement, but it keeps the intent legible.
 *
 * Previously this list was copy-pasted into both wipers and had silently
 * drifted — account deletion was leaving a deleted user's Postbox mail,
 * knowledge graph, chat history, and agent state behind. The compile-time guard
 * at the bottom of this file now forces every schema table to be classified as
 * either tenant data (here) or non-tenant (handled separately), so the lists
 * can never drift again.
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
	// IMAP folder membership (#927): derived from mailMessages the same way.
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

	// ── Automations (children first) ──
	'automationStepRuns',
	'automationRuns',
	'automationSteps',
	'automationStatShards',
	'automations',

	// ── Transactional ──
	// Attachment bytes a transactional API request stored but no Send claimed
	// yet; the step frees each blob with its row.
	'transactionalPendingUploads',
	// Recorded send completions that threw (#1195): a pointer at a Send plus the
	// worker outcome, which can carry the rendered message. Before both send tables.
	'sendCompletionFailurePayloads',
	'sendCompletionFailures',
	'transactionalSends',
	'transactionalEmails',

	// ── Webhooks ──
	'mtaCampaignAlertReceipts',
	'webhookDeliveryLogs',
	'webhookPayloads',
	// Bounces and complaints that matched no Send (#1194), kept for counting and
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

	// ── AI provider configuration (#1101) ──
	// The chosen language, embedding and decision providers plus the encrypted
	// API keys someone entered for this workspace. Wiped with the workspace: keys
	// that outlived it would keep billing their owner for whoever sets the
	// workspace up next, behind a masked preview nobody recognises. The
	// deployment's own `LLM_*` env fallback is untouched.
	'aiProviderConfig',

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
 * Tables deliberately NOT wiped by the tenant-data paths, with the reason each
 * is excluded. Listed explicitly so the exhaustiveness guard below can prove
 * the union of {tenant, non-tenant} covers the whole schema.
 */
export const NON_TENANT_TABLES = [
	// Auth identity — deleted explicitly by the account-deletion / reset paths,
	// or owned by BetterAuth (user/account/organization/member live in the
	// betterAuth component schema, not here).
	'userProfiles',
	'onboardingProgress',
	// Per-user first-login checklist, keyed by authUserId like userProfiles.
	// Deleted with the departing user in the member-erasure path and cleared by
	// the dev reset step; never org-scoped, so not swept by the tenant walker.
	'userOnboarding',
	// "You can send now" onboarding nudges, keyed by authUserId like
	// `userOnboarding` and deleted with the departing member in the member-erasure
	// path. Holds no contact business data — a user id and two timestamps.
	'sendReadyNotices',
	// Last observed "can this instance send at all?" sample — deployment
	// infrastructure state (the edge detector behind those notices), recreated by
	// the next cron tick like the other regenerable telemetry singletons.
	'sendPathReadiness',
	'platformAdmins',
	// The deletion-tracking table itself — account deletion patches the request
	// row to `completed`, so it must survive the wipe.
	'accountDeletionRequests',
	// Member erasure's progress rows. The erasure they drive runs across a
	// workspace deletion (it waits for the sweep), so they must outlive it too.
	'memberErasureJobs',
	// Workspace deletion's own control plane (the durable job and the write
	// fence's switch). It has to outlive the tables it empties, and its finished
	// rows are the generation history.
	'workspaceDeletionJobs',
	'workspaceDeletionProgress',
	// The migration ledger: which data migrations ran on this deployment, how far
	// they got and when they finished. Deployment state, not org data: a contract
	// step reads it after any wipe, and a wipe must not make a finished migration
	// look as if it never ran.
	'migrationRuns',
	// Instance configuration singleton — recreated by setup; reset clears it in a
	// dedicated step. The flag singleton and counter rows split off it (plan 2.4)
	// go with it, in the same reset step and the walker's terminal steps.
	'instanceSettings',
	'featureFlagSettings',
	'instanceCounters',
	// Progress of the instance-wide sweep that clears body-search excerpts when
	// the operator turns the switch off: a generation, counts and a pagination
	// cursor, no message content. It follows the instance switch rather than the
	// org, and a sweep still running during a wipe must keep its fence.
	'mailBodySearchPurges',
	// The lost-send sweep's pass leases (#1208): which pass over which send range
	// is running, a generation and two timestamps, no Send or contact data. A
	// lease left behind by a wipe goes stale and is taken over by the next pass.
	'lostSendSweepLeases',
	// Instance infrastructure / regenerable caches — not org business data.
	'systemUpdates',
	// What each IMAP server reported about its release and wire contract
	// (ADR-0063): deployment infrastructure, regenerated by the next report.
	'imapServers',
	// Cache of the desktop releases GitHub has published, refetched by a cron —
	// public release metadata and manifests, regenerable in one poll.
	'desktopReleases',
	'backupState',
	'urlReputationCache',
	'providerRoutes',
	'providerHealth',
	'warmingState',
	'mtaIpReadinessAlerts',
	// Deployment-scoped transport capability fact: does this send transport let us
	// set a custom VERP return path? Keyed by transport id with no organizationId,
	// no credentials and no contact business data — a re-probeable property of the
	// relay itself, shared by every org on the deployment. Like `providerHealth`,
	// it is regenerable telemetry about infrastructure, so it is out of the tenant
	// wipe (wiping it would only force a needless re-probe).
	'sendTransportReturnPathProbes',
	// Microsoft SNDS per-IP daily telemetry. Keyed by the deployment's SENDING
	// IPs, not by anything of this org's: bands, filter results and trap counts
	// Microsoft attributes to the infrastructure. Regenerable by re-polling the
	// feed, so it is out of the tenant wipe like `warmingState` / `tlsReports`.
	'sndsIpDailyStats',
	// Inbound TLS-RPT (RFC 8460) aggregate reports from partner MX — operator
	// deliverability telemetry keyed by the partner's own report-id, not org
	// business data. Regenerable (partners re-send daily); not personal data of
	// this org's contacts, so it is out of the tenant wipe like warmingState.
	'tlsReports',
	// End-to-end encryption key material (Sealed Mail): the instance signing
	// identity plus per-address OpenPGP keypairs whose PUBLIC halves are published
	// for discovery. Kept on purpose (#1101), unlike `aiProviderConfig`: nobody
	// entered these as credentials, the instance minted them, and other instances
	// have recorded and pinned their fingerprints. The identity row signs the
	// manifest whose rotation feed is the only way a pinned key may change; a
	// wiped address key re-minted for a re-created address reaches every peer that
	// pinned the old one as a key change with no signed rotation, which each of
	// them has to re-accept by hand.
	'keyVault',
	// Sealed Mail recipient-key discovery cache + TOFU trust ledger. Holds only
	// PUBLIC keys of OTHER instances' recipients plus their pin state — a
	// regenerable discovery cache (re-fetched from the peer's manifest/WKD), not
	// this org's contact business data, so it is out of the tenant wipe like
	// `keyVault` and the other caches.
	'recipientKeys',
	// Sealed Mail published key-rotation statements. Signed old->new
	// fingerprint bindings we serve in the manifest rotation feed. Public material
	// only, regenerable from the vault's rotation history — instance crypto
	// infrastructure, not this org's contact business data, so it is out of the
	// tenant wipe like `keyVault` / `recipientKeys`.
	'keyRotations',
	// Replay claims for the bundled-plugin feedback route. One row per
	// accepted delivery, holding a HASH of the caller's signature and nothing
	// else: no address, no message id, no payload. It is wire-protocol
	// bookkeeping about requests the deployment received, it self-expires within
	// the signature contract's tolerance (minutes), and wiping it early would only
	// re-open a replay window — so it is out of the tenant wipe like the other
	// protocol/telemetry tables.
	'pluginWebhookDeliveries',
	// "When did this bundled transport's feedback channel last deliver?" — one
	// timestamp per transport kind, stamped when a batch finishes dispatching, so
	// the Delivery page can grade a channel that does not retain raw payloads.
	// Operational health telemetry about the deployment's own inbound plumbing:
	// no address, no message id, no payload, and regenerable the moment the next
	// batch arrives. Out of the tenant wipe like `providerHealth` and the other
	// protocol/telemetry tables — wiping it would only make a working channel
	// read as `awaiting_event` until the provider next spoke.
	'pluginWebhookFeedbackActivity',
	// Replay claims for single provider events (Mandrill, #1228): the adapter's
	// address-free `replayKey` (event name, provider message id, timestamp) and
	// the claim state, nothing else. Wire-protocol bookkeeping like
	// `pluginWebhookDeliveries`, self-expiring a week after the event; wiping
	// it early would only re-open a replay window.
	'inboundEventClaims',
] as const satisfies readonly TableNames[];

/**
 * Compile-time guard: every table in the schema must be classified as either
 * tenant data or non-tenant. If you add a table to the schema without placing
 * it in one of the lists above, this errors with the offending table name(s).
 */
type UnclassifiedTable = Exclude<
	TableNames,
	(typeof TENANT_TABLES)[number] | (typeof NON_TENANT_TABLES)[number]
>;
type AssertAllTablesClassified<_T extends never> = true;
export type _TenantTablesAreExhaustive = AssertAllTablesClassified<UnclassifiedTable>;
