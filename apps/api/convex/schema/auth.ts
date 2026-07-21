import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { jsonPrimitiveRecord } from '../lib/convexValidators';
import { auditActionValidator, auditResourceValidator } from '../auditActions/catalog';

/**
 * Auth + accountability tables — userProfiles, apiKeys, platformAdmins,
 * accountDeletionRequests, onboardingProgress, userOnboarding, accessRequests,
 * auditLogs, invitationResends.
 *
 * The deployment-wide operator singletons (instanceSettings, systemUpdates,
 * backupState, aiProviderConfig) live in the sibling `schema/instance.ts`.
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

	// API Keys - authenticate API requests from external applications
	apiKeys: defineTable({
		name: v.string(), // User-friendly name for the key
		// Hash of the key - the actual key is only shown once on creation
		keyHash: v.string(),
		// Prefix of the key for identification (e.g., "lm_live_abc...") - first 8 chars after prefix
		keyPrefix: v.string(),
		// Permissions and scope. For a plugin-bound key these are the *requested*
		// scopes; the *effective* scopes are re-derived on every request as the
		// intersection with the plugin's declared capabilities and the operator's
		// grants (see plugins/apiKeyBinding.ts), so a disabled plugin or revoked
		// grant fails the key closed immediately.
		scopes: v.optional(v.array(v.string())),
		// Tier-2 binding: when set, this key belongs to a connected app / bundled
		// plugin. Its effective scopes are gated by that plugin's manifest and the
		// operator's capability grants, and it can be revoked in one shot by
		// pluginId (auth/apiKeys.ts:revokeByPlugin). Absent ⇒ a standalone
		// operator-managed key whose stored scopes are authoritative.
		pluginId: v.optional(v.string()),
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
		.index('by_active', ['isActive'])
		.index('by_plugin_id', ['pluginId']),

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
		// Host-attributed plugin actions carry both fields. Legacy/core rows omit
		// them; Owlat remains single-org, but explicit scope keeps plugin audit
		// data safe if that deployment invariant changes later.
		organizationId: v.optional(v.string()),
		pluginId: v.optional(v.string()),
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
		.index('by_organization_id_and_created_at', ['organizationId', 'createdAt'])
		.index('by_organization_id_and_plugin_id_and_created_at', [
			'organizationId',
			'pluginId',
			'createdAt',
		])
		.index('by_user_and_created_at', ['userId', 'createdAt']),

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
};
