import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Mailbox provisioning and membership.
 *
 * Reserved-mailbox intents attached to invitations, the mailboxes themselves,
 * their member rows, and the user-facing request queue for a new mailbox.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailboxesTables = {
	// Reserved-mailbox intent attached to a BetterAuth invitation. Admins
	// can pre-pick `localpart@verifiedDomain` at invite time; the row is
	// consumed (`claimForInvitation`) when the invitee accepts and we
	// finally have their `userId`.
	pendingMailboxes: defineTable({
		invitationId: v.string(), // BetterAuth invitation ID
		inviteeEmail: v.string(), // canonical lowercase — claim is bound to this identity
		organizationId: v.string(),
		localpart: v.string(), // canonical lowercase
		// Sending domain at invite time. It does NOT have to be verified yet: on a
		// brand-new instance an admin can reserve a mailbox on a domain that is
		// still registering/pending DNS, so the earliest invitees get "reserved,
		// activates when your domain verifies" progress instead of a dead end. The
		// reservation only materializes into a live mailbox once the domain is
		// verified (claim gate in mail/pendingMailbox.ts + the verify-time sweep).
		domain: v.string(),
		address: v.string(), // canonical "${localpart}@${domain}"
		displayName: v.optional(v.string()),
		createdAt: v.number(),
		createdByUserId: v.string(), // inviter — audit only
		// Set when the invitee ACCEPTS while the domain is still unverified: the
		// claim is parked in "awaiting_domain" and stamped with the accepting
		// BetterAuth userId. The verify-time sweep provisions ONLY rows carrying
		// this id, using it directly — so acceptance, org-match and identity
		// binding are facts recorded at accept time, never re-derived by email
		// (which would wrongly provision a not-yet-accepted registrant and miss
		// mixed-case profile emails). Absent ⇒ nobody has accepted yet.
		acceptedByUserId: v.optional(v.string()),
	})
		.index('by_invitation', ['invitationId'])
		.index('by_address', ['address'])
		// Look up an invitee's reservation by their email at first login (the
		// fresh-start welcome shows "your mailbox X is reserved — claim it").
		.index('by_invitee_email', ['inviteeEmail'])
		// Sweep every reservation on a domain when it finally verifies, so already-
		// accepted invitees' mailboxes provision the moment the domain goes live.
		.index('by_domain', ['domain']),

	// Per-user mailbox identity (e.g. user@owlat.test).
	// One BetterAuth user can own multiple mailboxes.

	mailboxes: defineTable({
		userId: v.string(), // BetterAuth user ID (owner)
		organizationId: v.string(),
		address: v.string(), // canonical lowercase
		domain: v.string(), // domain part for filtering
		displayName: v.optional(v.string()),
		// Sharing model. undefined ⇒ 'personal' (a single user's mailbox;
		// back-compat for all pre-shared-inbox rows). 'shared' ⇒ a team inbox
		// whose access is governed by explicit `mailboxMembers` rows rather than
		// by the owning `userId` alone. NOTE: distinct from `kind` below, which
		// discriminates the *transport* (hosted vs external), not the sharing
		// model — the two are orthogonal. 'seed' ⇒ the mailbox row behind a
		// DELIVERABILITY SEED account: org infrastructure that is NOT anybody's
		// inbox. It is filtered out of every caller-visible mailbox surface
		// (`mail/permissions.ts::loadAccessibleMailboxes`,
		// `mail/mailbox/identity.ts::getActiveMailboxForUser`), so connecting a seed can
		// never put the operator's consumer address in their own Postbox nor make
		// the fresh-start flow believe they already have a mailbox.
		scope: v.optional(v.union(v.literal('personal'), v.literal('shared'), v.literal('seed'))),
		// Transport discriminator. undefined ⇒ 'hosted' (Owlat-hosted mailbox;
		// back-compat for pre-external rows). 'external' ⇒ backed by a
		// user-connected IMAP/SMTP account (see externalMailAccounts).
		kind: v.optional(v.union(v.literal('hosted'), v.literal('external'))),
		// Set when kind='external'; links to the connection/credentials row.
		externalAccountId: v.optional(v.id('externalMailAccounts')),
		// Outbound transport preference for an EXTERNAL mailbox (ignored for
		// hosted mailboxes). undefined ⇒ 'external' — send through the user's own
		// SMTP via the mail-sync worker, the natural default after an import.
		// 'instance' ⇒ route outbound through this deployment's transport (the MTA
		// / SES the instance is configured with) so mail from an already-imported
		// mailbox ships from Owlat's reputation. Reversible any time under Postbox
		// settings → Sending. Switching to 'instance' is gated: the from-domain
		// must be a VERIFIED sending domain on the instance (DKIM alignment) AND
		// an instance transport must be configured — enforced in
		// mail/sendingSwitch.ts::setSendingPreference, never assumed here.
		outboundPreference: v.optional(v.union(v.literal('external'), v.literal('instance'))),
		status: v.union(v.literal('active'), v.literal('suspended'), v.literal('deleted')),
		quotaBytes: v.optional(v.number()), // null = unlimited (always unset for external)
		usedBytes: v.number(),
		uidValidity: v.number(), // initialized to Date.now()
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_address', ['address'])
		.index('by_user', ['userId'])
		.index('by_domain', ['domain'])
		.index('by_status', ['status'])
		// Enumerate every shared (team) inbox org-wide — the admin management
		// surface (mail/mailboxMembers.ts::listShared). Personal mailboxes keep
		// `scope` unset, so the 'shared' range stays small by construction.
		.index('by_scope', ['scope']),

	// Explicit membership on a mailbox — the access-control source of truth for
	// shared (team) inboxes. A personal mailbox carries exactly one row: an
	// 'owner' membership for its `mailboxes.userId`, written at provision time
	// (mail/mailbox/identity.ts). A shared mailbox adds 'member' (and further
	// 'owner') rows for the teammates who may use it.
	//
	// Org membership alone grants nothing here — access is either org
	// owner/admin acting on behalf, the mailbox's own `userId`, or an explicit
	// row in this table (see mail/permissions.ts::requireMailboxAccess).
	//
	// Wiped by the org-deletion walker and the dev reset (registered in
	// lib/tenantTables.ts before `mailboxes`, so members go before the parent).

	mailboxMembers: defineTable({
		mailboxId: v.id('mailboxes'),
		authUserId: v.string(), // BetterAuth user ID of the member
		role: v.union(v.literal('owner'), v.literal('member')),
		addedBy: v.string(), // BetterAuth user ID that granted the membership (audit)
		createdAt: v.number(),
	})
		// Access checks look up (mailbox, user) → membership; the compound index
		// is the hot path (one point read per authz decision). It also serves
		// "every member of a mailbox" (member management, cascade delete) as a
		// prefix query — `q.eq('mailboxId', …)` only — so no separate
		// `by_mailbox` single-column index is needed.
		.index('by_mailbox_user', ['mailboxId', 'authUserId'])
		// List every mailbox a user belongs to (identity resolution / inbox list).
		.index('by_user', ['authUserId']),

	// Pending team-inbox membership grant — the shared-inbox analogue of
	// `pendingMailboxes`. When an owner adds an email that is NOT yet an org
	// member to a team inbox, we reserve a grant here (and issue the org
	// invite); the grant is consumed into a real `mailboxMembers` row when that
	// person accepts and we finally have their `userId`.
	//
	// The grant is BOUND to `inviteeEmail` (canonical lowercase): the claim only
	// matches the accepting user's own login email, so another org member who
	// learned the invite can't take over someone else's inbox access (same
	// anti-hijack property as `pendingMailboxes`). `mailboxAddress` is
	// denormalized so the invitation email — sent by the auth hook before we
	// have a mailbox join — can name the inbox without a lookup.
	//
	// Wiped by the org-deletion walker and the dev reset (registered in
	// lib/tenantTables.ts before `mailboxes`, so grants go before the parent).

	pendingMailboxMembers: defineTable({
		organizationId: v.string(),
		inviteeEmail: v.string(), // canonical lowercase — claim is bound to this identity
		mailboxId: v.id('mailboxes'),
		mailboxAddress: v.string(), // denormalized team-inbox address (for the invite email)
		invitedByUserId: v.string(), // inviter — audit only
		createdAt: v.number(),
	})
		// Claim (accepting user's email) and the auth-hook email lookup both key
		// on (org, email); a person may be pre-added to several inboxes at once,
		// so this is a prefix range, not a point read.
		.index('by_org_email', ['organizationId', 'inviteeEmail'])
		// Cascade-clean grants when a team inbox is deleted (mail/mailbox/identity.ts:remove).
		.index('by_mailbox', ['mailboxId']),

	// External mailbox connection (BYO IMAP/SMTP). Per-user link to an EXISTING
	// external mailbox (Gmail, Fastmail, a company server). 1:1 with a `mailboxes`
	// row whose kind='external'. Credentials are encrypted at rest (AES-256-GCM);
	// read queries NEVER return the ciphertext/iv/tag — only the mail-sync worker
	// (which holds INSTANCE_SECRET) decrypts. The envelope shape is versioned by
	// CURRENT_EXTERNAL_MAIL_CRED_VERSION in lib/constants.ts.

	mailboxRequests: defineTable({
		// BetterAuth user id of the member asking for a mailbox.
		authUserId: v.string(),
		organizationId: v.string(),
		// Denormalised for the admin list so it needn't join userProfiles.
		requesterEmail: v.string(),
		requesterName: v.optional(v.string()),
		// Optional free-text note ("I need marcel@…").
		note: v.optional(v.string()),
		// - open      — awaiting an admin.
		// - fulfilled — an admin provisioned the hosted mailbox straight from the
		//   request (the requester now has a live inbox).
		// - resolved  — a plain acknowledgement/decline (external account, or the
		//   admin handled it some other way); no mailbox was provisioned here.
		status: v.union(v.literal('open'), v.literal('fulfilled'), v.literal('resolved')),
		createdAt: v.number(),
		// The hosted mailbox provisioned from this request. Set only on the
		// `fulfilled` path; makes the fulfilment idempotent (a redelivered
		// provision returns this instead of standing up a second mailbox).
		fulfilledMailboxId: v.optional(v.id('mailboxes')),
		// Admin who resolved/fulfilled it + when (audit; unset while open).
		resolvedByUserId: v.optional(v.string()),
		resolvedAt: v.optional(v.number()),
	})
		.index('by_auth_user_id', ['authUserId'])
		.index('by_org_and_status', ['organizationId', 'status']),
};
