import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
import { registerBundledPluginCrons } from './plugins/cronRegistration';

const crons = cronJobs();

// Process scheduled campaigns every minute
// Catches campaigns whose scheduledAt has passed (backup for scheduler-based sends)
crons.interval(
	'process scheduled campaigns',
	{ minutes: 1 },
	internal.campaigns.send.processScheduledCampaigns
);

// Complete campaigns whose sends have all finished (safety net for the per-send
// completion callback): advances 'sending' → 'sent' when no queued sends remain.
crons.interval(
	'reconcile sending campaigns',
	{ minutes: 1 },
	internal.campaigns.lifecycle.reconcileSendingCampaigns,
	{}
);

// Re-drive campaign send walks that stalled mid-flight. resolveCampaignPage
// self-reschedules only after a successful hop, so any throw before that leaves
// the campaignSendJobs row stuck in 'resolving' with the walk halted and the
// remaining recipients undelivered. This watchdog resumes such a walk from its
// committed cursor (idempotent — no dupes, no drops).
crons.interval(
	'reconcile stuck campaign sends',
	{ minutes: 5 },
	internal.campaigns.sendJob.redriveStuckSendJobs,
	{}
);

// Roll sharded campaign send counters (campaignStatShards) into campaigns.stats*
// for recently-sent campaigns, so the read cache stays fresh as opens/clicks
// trickle in post-send. In-flight 'sending' campaigns are rolled up by the
// reconcile cron above.
crons.interval(
	'rollup sent campaign stats',
	{ minutes: 2 },
	internal.campaigns.statShards.rollupSentCampaignStats,
	{}
);

// Roll sharded automation run counters (automationStatShards) into
// automations.stats* (deriving statsActive) so the read cache stays fresh as
// contacts enter and runs complete.
crons.interval(
	'rollup automation stats',
	{ minutes: 1 },
	internal.automations.statShards.rollupAutomationStats,
	{}
);

// Process pending automation delays every 5 minutes
// Catches delay steps that may have been missed due to system issues
crons.interval(
	'process pending delays',
	{ minutes: 5 },
	internal.automations.stepWalker.processPendingDelays
);

// Process account deletions daily
// Handles accounts past their 30-day grace period
crons.interval(
	'process account deletions',
	{ hours: 24 },
	internal.auth.accountDeletion.processPendingDeletions
);

// Clean up old webhook delivery logs weekly
// Removes logs older than 30 days to prevent unbounded growth
crons.interval('cleanup webhook logs', { hours: 168 }, internal.webhooks.cleanup.cleanupOldLogs);

// Clean up old connected-app hook delivery logs weekly. connectedAppHookDeliveryLogs
// is written on every signed-hook invocation; without this cron its retention
// never runs and the table grows unbounded. Ages rows out at AUDIT_LOG_RETENTION_MS.
crons.interval(
	'cleanup connected-app hook delivery logs',
	{ hours: 168 },
	internal.connectedApps.hookDeliveryLogStore._cleanupHookDeliveryLogs,
	{}
);

// Clean up old raw webhook payloads weekly. webhookPayloads is written on every
// webhook ingest; without this cron its retention never runs and the table
// grows unbounded (only purged on full org deletion).
crons.interval(
	'cleanup webhook payloads',
	{ hours: 168 },
	internal.webhooks.payloads.cleanupOldPayloads,
	{}
);

// PII retention sweeps (see maintenance/retention.ts): audit trails age out
// after 30 days, form-submission IP/UA after 90; auth-failure rows after
// their TTL (the mailAuthFailures schema always claimed this cron — now it
// actually exists).
crons.interval(
	'retention: audit logs',
	{ hours: 24 },
	internal.maintenance.retention.sweepAuditLogs,
	{}
);
crons.interval(
	'retention: mail audit log',
	{ hours: 24 },
	internal.maintenance.retention.sweepMailAuditLog,
	{}
);
crons.interval(
	'retention: plugin llm accounting',
	{ hours: 24 },
	internal.maintenance.retention.sweepPluginLlmAccounting,
	{}
);
crons.interval(
	'retention: form submission metadata',
	{ hours: 24 },
	internal.maintenance.retention.scrubFormSubmissionMeta,
	{}
);
crons.interval(
	'retention: mail auth failures',
	{ hours: 24 },
	internal.mail.authRateLimit.sweepOld,
	{}
);

// Refresh segment cached counts every 30 minutes
// Keeps cachedCount/cachedCountUpdatedAt fresh for the segments list UI
crons.interval(
	'refresh segment counts',
	{ minutes: 30 },
	internal.segments.refreshAllSegmentCounts,
	{}
);

// Reconcile cached contact counts daily
// Corrects any drift from partial failures or missed updates
crons.interval(
	'reconcile contact counts',
	{ hours: 24 },
	internal.contacts.contacts.reconcileAllContactCounts,
	{}
);

// Reconcile cached topic member counts daily
crons.interval(
	'reconcile topic member counts',
	{ hours: 24 },
	internal.topics.topics.reconcileMemberCounts,
	{}
);

// Sync IP warming state from MTA every 5 minutes
crons.interval(
	'sync warming state',
	{ minutes: 5 },
	internal.delivery.warmingSync.syncWarmingState
);
crons.interval(
	'cleanup deliverability route state',
	{ minutes: 5 },
	internal.delivery.deliverabilityRouting.cleanupExpired,
	{}
);

// Keep the built-in MTA's infrastructure readiness visible to reactive
// Delivery surfaces. The MTA internally caches its TCP/25 probes, so this
// cadence does not create a connection storm against the probe target.
crons.interval('sync MTA health', { minutes: 2 }, internal.delivery.mtaHealth.sync, {});

// Clean up sending-reputation buckets older than 60 days every hour (both
// scopes). Risk is derived on read (ADR-0042), so no periodic recalculation.
crons.interval(
	'cleanup sending reputation',
	{ hours: 1 },
	internal.analytics.sendingReputation.recalculateAll,
	{}
);

crons.interval(
	'cleanup delivery compliance telemetry',
	{ hours: 1 },
	internal.delivery.complianceTelemetry.cleanupComplianceTelemetry,
	{}
);

crons.interval(
	'cleanup Google Postmaster telemetry',
	{ hours: 24 },
	internal.delivery.postmaster.cleanup,
	{}
);

// Evaluate the org reputation window hourly and auto-escalate Abuse status when
// risk is high/critical. Moved off the per-send-event hot path (FIX 3a-1): the
// wide org-window summarize runs once per cron tick instead of once per
// recipient. Abuse status dedupes transitions, so the deliverability gate still
// trips — just on the cron cadence rather than per event.
crons.interval(
	'evaluate reputation auto-enforce',
	{ hours: 1 },
	internal.analytics.sendingReputation.evaluateAutoEnforce,
	{}
);

// Write one daily reputation snapshot (delivery/bounce/complaint rate + sent
// count of the rolling window) so the Delivery health page has a history to
// draw its 30-day delivery-rate trend from, and prune points older than ~90
// days in the same run. `summarize` only derives the current window, so without
// this cron there is no time series to chart.
//
// Anchored to a fixed 00:05 UTC rather than a 24h interval: `crons.interval`
// re-anchors to deploy/edit time, so a redeploy that drifts across midnight UTC
// could skip a calendar day and leave a gap in the trend. A fixed daily slot
// keeps exactly one snapshot per UTC day.
crons.daily(
	'write delivery snapshot',
	{ hourUTC: 0, minuteUTC: 5 },
	internal.analytics.reputationSnapshots.writeDailySnapshot,
	{}
);

// Daily knowledge graph confidence decay and expiration cleanup
crons.interval(
	'knowledge graph maintenance',
	{ hours: 24 },
	internal.knowledge.maintenance.runDecay,
	{}
);

// Daily contact-scoped knowledge dedup-merge: collapse near-identical facts a
// large mailbox import extracts about the same contact many times over.
crons.interval(
	'knowledge graph dedup',
	{ hours: 24 },
	internal.knowledge.maintenance.runKnowledgeDedup,
	{}
);

// Daily reap of stale, low-confidence ('ambiguous') LLM-inferred edges past
// their TTL (knowledge/relationDecay.ts). Edge confidence is NOT time-decayed in
// general — this only sheds the long tail of unreinforced LLM guesses.
crons.interval(
	'knowledge graph reap ambiguous edges',
	{ hours: 24 },
	internal.knowledge.relationDecay.reapAmbiguousEdges,
	{}
);

// Daily recompute of the cached knowledge-graph analytics snapshot (god nodes,
// approximate communities, confidence distribution, surprising connections). No-op
// when ai.knowledge.analytics is off; backs the member-only analytics dashboard.
crons.interval(
	'knowledge graph analytics',
	{ hours: 24 },
	internal.knowledge.graphAnalyticsRecompute.recomputeStats,
	{}
);

// Safety-net: re-schedule semantic-file processing (text extraction, embedding,
// auto-tags) for recently-created files whose scheduled processFile was missed.
crons.interval(
	'backfill unprocessed files',
	{ minutes: 15 },
	internal.semanticFiles.backfillUnprocessed,
	{}
);

// Retry failed agent pipeline actions every 5 minutes
// Picks up actions that failed and haven't exceeded the retry limit
crons.interval(
	'retry failed agent actions',
	{ minutes: 5 },
	internal.inbox.processingLifecycle.retryFailedActions,
	{}
);

// Reconcile inbound messages wedged in `approved` after a lost send-completion
// callback. Re-enqueues the agent reply when no queued send remains in flight.
crons.interval(
	'reconcile stuck approved inbox messages',
	{ minutes: 5 },
	internal.inbox.processingLifecycle.reconcileStuckApproved,
	{}
);

// Give up on clarification questions the owner never answered: after the
// configurable window, draft a flagged best-guess (never auto-send-eligible)
// so an abandoned `awaiting_clarification` message can't wedge forever.
crons.interval(
	'reconcile abandoned clarifications',
	{ minutes: 30 },
	internal.inbox.processingLifecycle.reconcileAbandonedClarifications,
	{}
);

// Team-inbox snooze sweep — float snoozed conversation threads back into the
// Open filter once their snoozedUntil has passed (stamps a "returned" marker).
crons.interval(
	'inbox wake snoozed threads',
	{ minutes: 1 },
	internal.inbox.snooze.internalSweep,
	{}
);

// Thread-presence sweep — delete shared-inbox presence rows whose heartbeat has
// aged past the 60s active window (tab closed without a clean leave, laptop
// slept). Keeps threadPresence bounded; presence is read-side only.
crons.interval(
	'sweep expired thread presence',
	{ minutes: 1 },
	internal.inbox.presence.internalSweep,
	{}
);

// Channel health checks every 5 minutes
// Monitors SMS, WhatsApp, webhook channel connectivity
crons.interval(
	'channel health checks',
	{ minutes: 5 },
	internal.unifiedMessages.runChannelHealthChecks
);

// Poll provider delivery status for outbound channel messages still at `sent`
// every 5 minutes. dispatchOutbound records `sent` off the synchronous send;
// carrier progression (delivered/read) and post-acceptance failures only show
// up on a later poll, so without this the unified-timeline status badge for
// SMS/WhatsApp/generic could never advance past `sent`.
crons.interval(
	'poll channel delivery status',
	{ minutes: 5 },
	internal.channels.outbound.pollDeliveryStatus,
	{}
);

// Agent metrics rollup every 5 minutes
// Computes queue depth, latency, error rates, evaluates circuit breakers
crons.interval('agent metrics rollup', { minutes: 5 }, internal.agentHealth.rollupMetrics);

// Reset autonomy daily action counts every 24 hours
crons.interval('reset autonomy daily counts', { hours: 24 }, internal.autonomy.resetDailyCounts);

// Weekly autonomy threshold adjustment
// Tightens thresholds on high rejection, loosens on low rejection
crons.interval(
	'adjust autonomy thresholds',
	{ hours: 168 },
	internal.autonomyFeedback.adjustThresholds
);

// Report instance analytics to control plane every 15 minutes
crons.interval('report analytics', { minutes: 15 }, internal.analytics.reporter.reportMetrics);

// Reconcile cached transactional send count daily
crons.interval(
	'reconcile transactional send counts',
	{ hours: 24 },
	internal.analytics.reporter.reconcileTransactionalSendCount,
	{}
);

// Personal-mail (Postbox) safety-net: dispatch overdue scheduled/pending sends
// that the per-draft scheduler may have missed (e.g. deployment was offline).
crons.interval(
	'postbox dispatch overdue drafts',
	{ minutes: 1 },
	internal.mail.outboundCron.dispatchOverdueDrafts,
	{}
);

// Postbox snooze sweep — wake messages whose snoozedUntil has passed.
crons.interval(
	'postbox wake snoozed messages',
	{ minutes: 1 },
	internal.mail.snooze.internalSweep,
	{}
);

// Postbox follow-up sweep — resurface sent threads whose "remind me if no
// reply" deadline passed without an inbound reply.
crons.interval(
	'postbox follow-up reminders',
	{ minutes: 1 },
	internal.mail.followUps.internalSweep,
	{}
);

// Postbox Reply Queue reconcile — re-schedule needs-reply classification for
// threads whose ingest-time scheduled check was lost (deploy restart etc.).
crons.interval(
	'postbox needs-reply reconcile',
	{ minutes: 5 },
	internal.mail.needsReply.sweepPending,
	{}
);

// Daily Brief — rebuild the "what needs you today" digest per active mailbox
// (mail/dailyBrief.ts): ranked pending replies + clarifications + due follow-ups
// + open commitments, plus the auditable low-signal bundle. Reads persisted
// signals only (no LLM spend); in-app surface via getLatestBrief.
crons.interval('build daily briefs', { hours: 24 }, internal.mail.dailyBrief.buildDailyBriefs, {});

// Commitment sweep — bidirectional deadline/promise tracking (mail/commitments.ts).
// Schedules cheap-tier LLM extraction for recent sent promises (bounded fan-out)
// and arms a pre-lapse reminder (reusing mail/followUps.ts) for any open
// commitment inside its reminder window, so a promise the owner made can't lapse
// unseen. Fail-soft; never sends mail.
crons.interval('commitment reminder sweep', { minutes: 30 }, internal.mail.commitments.sweep, {});

// Permanently delete soft-deleted contacts whose 30-day retention has expired.
// Cascades to contact-owned children and nulls out FKs in append-only tables.
crons.interval(
	'cleanup soft-deleted contacts',
	{ hours: 24 },
	internal.contacts.contacts.cleanupSoftDeletedContacts,
	{}
);

// Sealed Mail: refresh expiring recipient-key discovery rows every 30 minutes
// (e2ee/discovery.ts). Positive hits carry a 24h TTL and negatives a 1h TTL, so
// this picks up rotated/newly-published peer keys and retires stale negatives
// without a discovery on every send. A no-op when Sealed Mail is off.
crons.interval(
	'refresh recipient key discovery',
	{ minutes: 30 },
	internal.e2ee.discovery.refreshExpiringRecipientKeys,
	{}
);

// Auto-merge unambiguous duplicate contacts (same email/phone across two
// contacts) every 6 hours. Single-org hygiene; bounded per run.
crons.interval(
	'auto-merge duplicate contacts',
	{ hours: 6 },
	internal.contacts.identities.autoMergeDuplicates,
	{ limit: 20 }
);

// Append every bundled plugin cron (generated catalog) after the core crons,
// each wrapped in the host runtime so flag/grant/env are rechecked per tick and
// every run is attributed to its plugin. No-op when no plugin contributes crons.
registerBundledPluginCrons(crons);

export default crons;
