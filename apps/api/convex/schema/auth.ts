import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { jsonPrimitiveRecord, updateStepResultValidator } from '../lib/convexValidators';
import { auditActionValidator, auditResourceValidator } from '../auditActions/catalog';
import {
	embeddingProviderKindValidator,
	languageProviderKindValidator,
} from '../lib/aiProviderConfigValidators';

/**
 * Auth + instance-admin tables — userProfiles, instanceSettings, apiKeys, platformAdmins,
 * accountDeletionRequests, onboardingProgress, userOnboarding, auditLogs, systemUpdates.
 *
 * Spread into `defineSchema()` from schema.ts via `...authTables`.
 */
export const authTables = {
	// UserProfiles table - stores additional user profile data linked to BetterAuth users
	// The authUserId references the user ID from BetterAuth's user table
	userProfiles: defineTable({
		authUserId: v.string(), // BetterAuth user ID (string format)
		email: v.string(),
		name: v.optional(v.string()),
		image: v.optional(v.string()),
		// Soft-delete fields: when set, the user is considered deleted. Daily cron
		// hard-deletes after the 30-day retention window (see auth/accountDeletion).
		deletedAt: v.optional(v.number()),
		deletedBy: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_auth_user_id', ['authUserId'])
		.index('by_email', ['email'])
		.index('by_deleted_at', ['deletedAt']),

	// Instance Settings - app-specific settings for this Owlat instance
	instanceSettings: defineTable({
		// Timezone for scheduling (e.g., "America/New_York", "Europe/London")
		timezone: v.optional(v.string()),
		// Default sender information
		defaultFromName: v.optional(v.string()),
		defaultFromEmail: v.optional(v.string()),
		// Campaign senders are a curated list (see `campaignSenders`). When this
		// is on, campaign sends may also use any from-address on a VERIFIED
		// sending domain, not just the curated list. Defaults to OFF for everyone
		// (admins included) — the curated list is the safe default. The
		// verified-domain hard gate still applies in both branches.
		isCustomCampaignSendersAllowed: v.optional(v.boolean()),
		// Email theme settings
		emailTheme: v.optional(
			v.object({
				primaryColor: v.string(), // Main brand color (e.g., button backgrounds)
				fontFamily: v.string(), // Font for email content
				backgroundColor: v.string(), // Email body background color
				baseWidth: v.optional(v.number()), // Base content width in px (default: 600)
			})
		),
		// Instance is moving from another email platform. DEFAULT FALSE — Owlat is
		// its own platform by default. When true, first-login onboarding offers a
		// mail import; when false the welcome flow is a pure fresh-start and exposes
		// no import surface. Admin-gated write, member-readable via `settings.get`.
		isMigrationMode: v.optional(v.boolean()),
		// MTA-STS publishing posture (RFC 8461) for INBOUND mail to this
		// deployment. `none` (or unset) publishes no policy — byte-identical to
		// today. `testing` publishes a policy whose failures are only reported;
		// `enforce` requires senders to use verified TLS to a listed MX. The MX
		// host is the deployment's own EHLO_HOSTNAME; the policy body + id are
		// derived by `@owlat/shared/mtaStsPolicy`. Admin-gated write via
		// `settings.update`, served publicly by the `getMtaStsPolicy` query.
		mtaStsMode: v.optional(v.union(v.literal('none'), v.literal('testing'), v.literal('enforce'))),
		// Trusted ARC forwarders (Sealed Mail A5): domains whose validated ARC seal
		// (RFC 8617) we honour to RESCUE a DMARC fail on inbound forwarded mail —
		// a mailing-list / forwarding message that broke DKIM but whose sealer
		// attests the original passed skips Spam-routing instead of false-failing.
		// Unset ⇒ the code falls back to `DEFAULT_TRUSTED_ARC_FORWARDERS` from
		// `@owlat/shared/arcTrust`; an explicit `[]` disables the override entirely.
		// Admin-gated write via `settings.update`, editable in Settings → Delivery.
		trustedArcForwarders: v.optional(v.array(v.string())),
		// Feature toggles (see packages/shared/src/featureFlags.ts for the schema).
		// Unset keys fall back to FEATURE_FLAGS[key].default at resolution time.
		// Includes `campaigns.archive` — there is no separate `archiveEnabled` column.
		featureFlags: v.optional(v.record(v.string(), v.boolean())),
		// Timestamp of the last successful delivery test send (Settings → Delivery
		// "Send test email"). Drives the send-path-verified signal on the status
		// page and onboarding. Unset ⇒ no successful test recorded yet.
		deliveryTestLastSucceededAt: v.optional(v.number()),
		// Cached contact count for O(1) queries (maintained on contact create/delete)
		contactCount: v.optional(v.number()),
		// Cached transactional send count for analytics reporting (incremented on each send)
		transactionalSendCount: v.optional(v.number()),
		// Anti-abuse: organization status for spam/abuse prevention.
		// Per ADR-0011 the legacy `throttled` literal is dropped — it
		// never gated anything in the Abuse gate (module), so callers
		// treated it as `warned`. The MTA circuit breaker's path now
		// targets `warned` instead.
		abuseStatus: v.optional(
			v.union(
				v.literal('clean'), // Normal operation
				v.literal('warned'), // Warning issued, still operational
				v.literal('suspended'), // All sending blocked, account accessible
				v.literal('banned') // Account fully disabled
			)
		),
		abuseStatusReason: v.optional(v.string()),
		abuseStatusChangedAt: v.optional(v.number()),
		abuseStatusChangedBy: v.optional(v.string()), // admin user ID or 'system'
		// Anti-abuse: sending tier for new account warmup
		sendingTier: v.optional(
			v.union(
				v.literal('new'), // 0-7 days: 50 emails/day
				v.literal('warming'), // 7-30 days: 500 emails/day
				v.literal('established'), // 30-90 days: 5,000 emails/day
				v.literal('trusted') // 90+ days: unlimited
			)
		),
		dailySendCount: v.optional(v.number()),
		dailySendCountResetAt: v.optional(v.number()),
		// AGGREGATED — singleton inbound message counters by processing
		// status. Maintained by `inbox/processingLifecycle.ts` (transitions)
		// and `inbox/messages.ts` (insert). The Dashboard
		// review-queue/agent-health cards and inbox badge composables all
		// subscribe to these; pre-deepening `getInboundStats` did
		// `inboundMessages.collect()` per subscriber, which grew linearly
		// with deployment age.
		inboxStats: v.optional(
			v.object({
				received: v.number(),
				processing: v.number(), // security_check + classifying + drafting
				draftReady: v.number(),
				approved: v.number(),
				sent: v.number(),
				quarantined: v.number(),
				failed: v.number(),
				rejected: v.number(),
				archived: v.number(),
				total: v.number(),
			})
		),
		// AGGREGATED — count of `conversationThreads` currently in the 'open'
		// status (the human-review backlog). Maintained through
		// `applyOpenThreadDelta` (lib/inboxStats.ts) by every create-as-open /
		// status-transition path: the Conversation thread module
		// (`inbox/threads/module.ts`) for inbound activity, and the manual
		// outbound-channel thread opener
		// (`unifiedMessages.resolveOutboundThread`). Bumped on create-as-open and
		// on a non-open → open transition, decremented on open → non-open.
		// `getInboundStats` reads this instead of collecting the whole
		// open-thread set per subscriber.
		openThreads: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.optional(v.number()),
	}),

	// API Keys - authenticate API requests from external applications
	apiKeys: defineTable({
		name: v.string(), // User-friendly name for the key
		// Hash of the key - the actual key is only shown once on creation
		keyHash: v.string(),
		// Prefix of the key for identification (e.g., "lm_live_abc...") - first 8 chars after prefix
		keyPrefix: v.string(),
		// Permissions and scope (future use)
		scopes: v.optional(v.array(v.string())),
		// Usage tracking
		lastUsedAt: v.optional(v.number()),
		// Status
		isActive: v.boolean(),
		revokedAt: v.optional(v.number()),
		// Optional hard expiry (epoch ms). When set and in the past, the key is
		// rejected at verification even while `isActive` is still true.
		expiresAt: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_key_hash', ['keyHash'])
		.index('by_active', ['isActive']),

	// Platform Admins - super-admin accounts for platform-level abuse management
	platformAdmins: defineTable({
		authUserId: v.string(), // BetterAuth user ID
		email: v.string(),
		role: v.union(v.literal('admin'), v.literal('superadmin')),
		createdAt: v.number(),
	})
		.index('by_auth_user_id', ['authUserId'])
		.index('by_email', ['email']),

	// Account Deletion Requests - tracks user account deletion requests with 30-day grace period
	accountDeletionRequests: defineTable({
		userProfileId: v.id('userProfiles'),
		email: v.string(), // User's email for confirmation/communication
		// When the request was made
		requestedAt: v.number(),
		// When the account will be permanently deleted (requestedAt + 30 days)
		scheduledForDeletion: v.number(),
		// Secure token for canceling the deletion
		cancellationToken: v.string(),
		// Current status of the request
		status: v.union(
			v.literal('pending'), // Waiting for 30-day period
			v.literal('cancelled'), // User cancelled the deletion
			v.literal('completed') // Account has been permanently deleted
		),
		// Optional reason provided by user
		reason: v.optional(v.string()),
		// When status changed (for cancelled/completed)
		statusChangedAt: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
	})
		.index('by_user_profile', ['userProfileId'])
		.index('by_status', ['status'])
		.index('by_scheduled_for_deletion', ['scheduledForDeletion'])
		.index('by_cancellation_token', ['cancellationToken']),

	// Onboarding dismissal — INSTANCE-SCOPED (single org per deployment).
	// Step progress is derived live from real instance data in
	// `auth/onboarding.getWithActualProgress`, so the only thing worth storing is
	// whether an admin dismissed the surface. A row records WHO dismissed it; the
	// read side ORs across all rows (`by_dismissed`), so a dismissal by any admin
	// hides the onboarding surface for every admin and browser.
	onboardingProgress: defineTable({
		userId: v.string(), // BetterAuth user ID of the admin who dismissed onboarding
		// Whether onboarding has been dismissed/skipped (instance-wide on read)
		dismissed: v.boolean(),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
		dismissedAt: v.optional(v.number()),
	})
		.index('by_user', ['userId'])
		.index('by_dismissed', ['dismissed']),

	// Per-user first-login onboarding state — PER-USER (keyed by BetterAuth
	// authUserId), deliberately separate from the instance-wide admin surface
	// above (`onboardingProgress` / auth/onboarding.ts). This tracks where an
	// individual member is in their personal "get set up" journey: their
	// mailbox, their optional import, their first send. Each step is stored as a
	// completion TIMESTAMP (unset ⇒ not done, set ⇒ done at that instant); the
	// timestamps are written idempotently from the real product flows (mailbox
	// claim/connect, migration start/complete, knowledge indexing complete,
	// post-import sending switch, first send) — never polled. `dismissedAt`
	// records the member hiding their own checklist; it does not affect anyone
	// else. One row per user, upserted on first write.
	userOnboarding: defineTable({
		authUserId: v.string(), // BetterAuth user ID this checklist belongs to
		// Step completion timestamps (epoch ms). Unset ⇒ step not completed.
		mailboxReady: v.optional(v.number()), // a personal/external mailbox is live
		importStarted: v.optional(v.number()), // a mailbox migration was kicked off
		importDone: v.optional(v.number()), // the migration import phase finished
		knowledgeIndexed: v.optional(v.number()), // AI knowledge indexing finished
		sendingSwitched: v.optional(v.number()), // outbound switched to this instance
		firstSendDone: v.optional(v.number()), // first message sent from this instance
		// The member has seen the first-login welcome screen. Set once, the first
		// time they land on /welcome; drives the middleware "returning users never
		// see the welcome" check. Independent of dismissedAt.
		welcomedAt: v.optional(v.number()),
		// The member dismissed their own onboarding checklist (per-user only).
		dismissedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_auth_user_id', ['authUserId']),

	// Access requests — the door out of the "invitation required" dead-end.
	//
	// A signed-in user who belongs to no organization (they authenticated but
	// were never invited) can ask the admins for access instead of only being
	// able to sign out. This row is a NOTIFICATION, never a grant: creating it
	// never adds the user to the org — an admin still invites them through the
	// normal members flow. Mirrors `mailboxRequests` (mail/mailboxRequest.ts):
	// one open row per user (refreshed, not stacked), surfaced to admins on the
	// dashboard, resolved by acknowledgement.
	accessRequests: defineTable({
		// BetterAuth user id of the orgless requester.
		authUserId: v.string(),
		// The single deployment organization the request is addressed to.
		organizationId: v.string(),
		// Denormalised for the admin list so it needn't join userProfiles.
		requesterEmail: v.string(),
		requesterName: v.optional(v.string()),
		// Optional free-text note ("I'm on the marketing team").
		note: v.optional(v.string()),
		status: v.union(v.literal('open'), v.literal('resolved')),
		createdAt: v.number(),
		// Admin who resolved it + when (audit; unset while open).
		resolvedByUserId: v.optional(v.string()),
		resolvedAt: v.optional(v.number()),
	})
		.index('by_auth_user_id', ['authUserId'])
		.index('by_org_and_status', ['organizationId', 'status']),

	// Audit Logs - tracks organization member actions for accountability and debugging.
	// Action and resource literal unions live in `auditActions/catalog.ts` —
	// adding a new action is a one-place change there.
	auditLogs: defineTable({
		userId: v.string(), // BetterAuth user ID who performed the action
		action: auditActionValidator,
		resource: auditResourceValidator,
		// Optional ID of the affected resource
		resourceId: v.optional(v.string()),
		// Additional details about the action — flat scalar map.
		// For nested change-tracking ({ from, to } / arrays / etc.), JSON-encode
		// into `detailsBlob` instead. `details` is shaped for fast indexed reads.
		details: v.optional(jsonPrimitiveRecord),
		// JSON-encoded nested payload for cases where `details` (flat scalars)
		// can't express the shape (e.g. multi-field diffs). Readers parse with JSON.parse.
		detailsBlob: v.optional(v.string()),
		// IP address of the request (if available)
		ipAddress: v.optional(v.string()),
		// User agent of the request (if available)
		userAgent: v.optional(v.string()),
		// Timestamp when the action occurred
		createdAt: v.number(),
	})
		.index('by_user', ['userId'])
		.index('by_action', ['action'])
		.index('by_resource', ['resource'])
		.index('by_created_at', ['createdAt'])
		.index('by_user_and_created_at', ['userId', 'createdAt']),

	// System updates — tracks upstream release checks and the history of
	// in-app updates applied on this instance. Populated by
	// apps/api/convex/systemUpdates.ts.
	//
	// Two kinds of documents share this table:
	//   - kind='latestCheck'   — cached result of the last GitHub release poll
	//   - kind='updateRun'     — one row per update attempt (success or failure)
	systemUpdates: defineTable({
		kind: v.union(v.literal('latestCheck'), v.literal('updateRun')),

		// ── Fields for kind='latestCheck' ──
		latestVersion: v.optional(v.string()), // e.g. "0.2.1"
		releaseNotes: v.optional(v.string()), // markdown body from GitHub
		publishedAt: v.optional(v.number()), // release publish time (epoch ms)
		checkedAt: v.optional(v.number()), // when we last polled (epoch ms)
		error: v.optional(v.string()), // populated if poll/update failed

		// ── Fields for kind='updateRun' ──
		versionFrom: v.optional(v.string()),
		versionTo: v.optional(v.string()),
		startedAt: v.optional(v.number()),
		finishedAt: v.optional(v.number()),
		status: v.optional(v.union(v.literal('running'), v.literal('success'), v.literal('failed'))),
		// Per-step result blob returned by the updater sidecar.
		steps: v.optional(updateStepResultValidator),
		// User who initiated the update (auth user ID)
		initiatedBy: v.optional(v.string()),
	})
		.index('by_kind_and_checkedAt', ['kind', 'checkedAt'])
		.index('by_kind_and_startedAt', ['kind', 'startedAt']),

	// Resend throttle for organization invitations. One row per BetterAuth
	// invitationId records when its invite email was last (re)sent. The
	// `sendInvitationEmail` hook stamps and checks this via
	// `auth/invitationResend.enforceResendThrottle` on every send path, enforcing a
	// 1-per-minute floor regardless of how many times "Resend" is clicked (or how
	// often the API is hit directly). The copyable accept link is always available,
	// so this only rate-limits the email resend, never access to the invite itself.
	invitationResends: defineTable({
		invitationId: v.string(), // BetterAuth invitation ID (string format)
		organizationId: v.string(),
		lastSentAt: v.number(),
	}).index('by_invitation', ['invitationId']),

	// Operator-recorded backup plan for a self-hosted deployment. The Convex
	// backend runs in a container and cannot introspect the host's systemd
	// timer / cron entry (installed by `owlat backup-schedule enable`) or the
	// ./backups directory, so it CANNOT truthfully claim to have read the live
	// schedule. Instead this deployment-wide singleton records the operator's
	// own attestation of the daily-backup schedule plus any manual run they log
	// after running `scripts/backup.sh`. The Settings → Backups panel reads it
	// back and always shows the exact CLI commands to run on the host, so the
	// state here is honest ("recorded by you"), never a fabricated live reading.
	// Populated by apps/api/convex/backups.ts. One row per deployment.
	backupState: defineTable({
		// Whether the operator confirms the daily backup schedule is installed
		// on the host. Drives the self-host onboarding "Set up backups" pointer
		// (SelfHostOnboardingBanner.vue), which hides once this is true.
		isScheduleEnabled: v.boolean(),
		// Last manual backup the operator logged after running scripts/backup.sh.
		lastRunAt: v.optional(v.number()),
		lastRunStatus: v.optional(v.union(v.literal('success'), v.literal('failed'))),
		// Audit: who last changed this record (auth user email) and when.
		updatedAt: v.number(),
		updatedBy: v.optional(v.string()),
	}),

	// Pluggable AI providers (bring-your-own-key) — PER-ORG SINGLETON (single-org
	// per deployment; at most one row). Records the admin's choice of AI backend
	// across TWO DECOUPLED PLANES (2026-07-10 pluggable-AI-providers plan):
	//
	//   • LANGUAGE plane (all text generation) — `languageProviderKind` selects a
	//     registered adapter (hosted OpenAI/Anthropic/Google/OpenRouter via an
	//     encrypted key, OR the local OpenAI-compatible adapter via
	//     `languageBaseUrl` and NO key). `modelFast`/`modelCapable` are the per-tier
	//     model ids.
	//   • EMBEDDING plane (knowledge graph / semantic search) — resolved
	//     INDEPENDENTLY. `embeddingProviderKind` defaults to `'local'` so retrieval
	//     works under any language choice; a hosted embedder (OpenAI) is an override
	//     carrying its own key envelope.
	//
	// SECRETS AT REST: the language key (and optional hosted-embedder key) are
	// stored ONLY as an AES-256-GCM envelope (secretCiphertext/Iv/AuthTag +
	// EnvelopeVersion), exactly like `externalMailAccounts`, encrypted in a
	// `'use node'` action with `lib/credentialCrypto`. All envelope columns are
	// OPTIONAL — a local provider needs no key. Queries NEVER return the envelope,
	// only `keyPreview` + a "configured" boolean. Decrypt happens only at call time
	// inside a Node action. Env `LLM_*` remains the deployment fallback when this
	// row is absent; a present row wins (resolution is a later plan piece).
	//
	// `embeddingModelVersion` is the dimension guard: it is bumped whenever the
	// embedding model/provider changes so stale vectors are never silently mixed
	// with new-model vectors (callers re-index on a version change). Writes go
	// through the secure-by-default admin gate + `recordAuditLog`.
	aiProviderConfig: defineTable({
		// ── LANGUAGE plane ──
		languageProviderKind: languageProviderKindValidator,
		// Base-URL override — required for the local OpenAI-compatible adapter
		// (Ollama/vLLM/llama.cpp); unset for hosted providers using their default.
		languageBaseUrl: v.optional(v.string()),
		modelFast: v.string(),
		modelCapable: v.string(),
		// Language-provider API key envelope (absent for local, keyless providers).
		secretCiphertext: v.optional(v.string()),
		secretIv: v.optional(v.string()),
		secretAuthTag: v.optional(v.string()),
		secretEnvelopeVersion: v.optional(v.number()),
		// Non-secret masked preview of the language key (e.g. `sk-…a1b2`) for the UI.
		keyPreview: v.optional(v.string()),
		// ── EMBEDDING plane (resolved independently; local by default) ──
		embeddingProviderKind: embeddingProviderKindValidator,
		embeddingModel: v.optional(v.string()),
		// Dimension guard — bumped on any embedding model/provider change.
		embeddingModelVersion: v.number(),
		// Hosted-embedder API key envelope (only when embeddingProviderKind is hosted).
		embeddingSecretCiphertext: v.optional(v.string()),
		embeddingSecretIv: v.optional(v.string()),
		embeddingSecretAuthTag: v.optional(v.string()),
		embeddingSecretEnvelopeVersion: v.optional(v.number()),
		embeddingKeyPreview: v.optional(v.string()),
		updatedAt: v.number(),
	}),
};
