import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { jsonPrimitiveRecord, updateStepResultValidator } from '../lib/convexValidators';
import { sealPolicyValidator } from '../mail/sealPolicy';
import {
	embeddingProviderKindValidator,
	languageProviderKindValidator,
} from '../lib/aiProviderConfigValidators';

/**
 * Instance-administration tables — the deployment-wide singletons an operator
 * configures: instanceSettings, systemUpdates, backupState, aiProviderConfig.
 *
 * Split out of `schema/auth.ts` (which keeps the per-user identity and
 * accountability tables) once that file grew past the ~500 LOC split guideline
 * in apps/api/convex/CONVENTIONS.md.
 *
 * Spread into `defineSchema()` from schema.ts via `...instanceTables`.
 */
export const instanceTables = {
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
		// Sealed Mail (E3) org-level sealing policy (locked decision D2): `auto`
		// seals whenever every recipient has a usable pinned key, `ask` defers to
		// the composer opt-in (E5), `off` never seals. Unset ⇒ `auto`. Admin-gated
		// write via `workspaces/settings.update`.
		sealPolicy: v.optional(sealPolicyValidator),
		// Plaintext SMTP is rejected by default with 550 5.7.10. Owners/admins
		// may explicitly disable the floor for compatibility with legacy senders.
		isInboundTlsRequired: v.optional(v.boolean()),
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
		// Explicit operator approvals for capabilities requested by each bundled
		// plugin flag. The host still checks each grant at call time; disabling a
		// plugin clears its record so re-enabling always requires fresh approval.
		pluginCapabilityGrants: v.optional(v.record(v.string(), v.record(v.string(), v.boolean()))),
		// Operator-configured settings values for each bundled plugin, keyed by the
		// `plugin.<id>` flag key then by the plugin's settings-schema field key.
		// SECRET-kind field values are stored here server-side and NEVER returned to
		// the client — the settings overview query redacts them to a presence
		// boolean. Cleared wholesale when a plugin's settings are reset (or when a
		// removed plugin's residual config is purged); independent of the capability
		// grants above. Admin-gated writes via `plugins/settings`.
		pluginSettings: v.optional(v.record(v.string(), jsonPrimitiveRecord)),
		// Timestamp of the last successful delivery test send (Settings → Delivery
		// "Send test email"). Drives the send-path-verified signal on the status
		// page and onboarding. Unset ⇒ no successful test recorded yet.
		deliveryTestLastSucceededAt: v.optional(v.number()),
		// Latest non-secret health snapshot from the built-in MTA. Refreshed by a
		// Convex cron so reactive Delivery surfaces can report infrastructure
		// readiness without querying an external service from a database query.
		mtaHealth: v.optional(
			v.object({
				status: v.union(v.literal('ok'), v.literal('degraded'), v.literal('unreachable')),
				isRedisConnected: v.optional(v.boolean()),
				isWorkerAlive: v.optional(v.boolean()),
				isDnsReachable: v.optional(v.boolean()),
				isAllIpsBlocked: v.optional(v.boolean()),
				smtpOutbound: v.optional(
					v.object({
						status: v.union(v.literal('ok'), v.literal('degraded')),
						checkedAt: v.number(),
						ips: v.array(
							v.object({
								ip: v.string(),
								status: v.union(v.literal('ok'), v.literal('failed')),
								reason: v.optional(v.string()),
							})
						),
					})
				),
				observedAt: v.number(),
			})
		),
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
