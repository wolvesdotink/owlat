# Shared inbox is owner/admin-only

**Status:** accepted

## Context

The AI-assisted shared inbox (`conversationThreads` + `inboundMessages`, see the
`schema/inbox.ts` "AI-assisted shared inbox" tables) is an org-wide helpdesk: any
member could see and act on every customer conversation. Before this decision its
access floor was merely "authenticated org member":

- **Mutations** (`approveDraft`, `rejectDraft`, `editDraft`, `assignThread`,
  `updateThreadStatus`, `releaseFromQuarantine`, `blockSender`) used
  `authedMutation` + `requireAuthenticatedIdentity` — no role check.
- **Queries** (`listThreads`, `getThread`, `getReviewQueue`, `getQuarantined`,
  `getInboundStats`, `getMessageActions`) were soft-auth `publicQuery`s that
  returned data to *any* authenticated user.

So an `editor` — who per the permission map (`lib/sessionOrganization.ts`) cannot
send campaigns, manage templates, or manage contacts — could nonetheless
**approve and send** an AI-drafted customer reply, **block a sender** org-wide
(writing the shared `blockedEmails` list), **release** quarantined mail, and
**read every customer conversation**. That is a strictly larger capability than
sending a campaign, yet sat at a lower gate.

This is distinct from per-user **personal mailboxes** (`mail/*`, the IMAP/SMTP and
external-account features), which are correctly gated per-user by
`loadOwnedMailbox` / `loadOwnedMessage`: a non-admin may act only on their own
mailbox. The *shared* inbox has no per-user owner — it is the org's collective
support queue.

## Decision

The shared inbox is **owner/admin-only**.

- All seven mutations move to the `adminMutation` wrapper (ADR-0039), which
  enforces `requireAdminContext` (`organization:manage`). Handlers that need the
  actor id for audit/lifecycle read it from `getMutationContext(ctx).userId`
  (identical to the previous `identity.subject`).
- The queries keep their graceful soft-auth shape but gate on role: they resolve
  `getBetterAuthSessionWithRole(ctx)` and return empty (`[]` / `null` / empty
  page) for non-admins and anonymous callers, rather than throwing — so the UI's
  unauthenticated path is unchanged.

## Considered options

1. **Restrict to owners/admins** *(chosen)* — one admin gate, consistent with the
   sensitivity (reading all customer mail; sending replies). Simplest correct
   floor.
2. **Keep open to all members** — rejected: inconsistent with editors being
   unable to send campaigns, and exposes all customer conversations to every
   member.
3. **New `inbox:respond` permission** — a dedicated capability so a "support
   agent" could be granted inbox access without full admin. Deferred: there is no
   support-agent role today; the typed permission can be added later without
   reopening this decision (the wrappers and lint make that a localized change).

## Consequences

- Editors lose all shared-inbox read and write access; owners/admins are
  unaffected.
- `unifiedMessages.sendChatMessage` (which posts on a `conversationThreads`
  thread) is gated the same way (`requireOrgPermission(ctx, 'organization:manage')`),
  for consistency with the inbox it writes into.
- Regression coverage: `__tests__/inboundRoleEnforcement.integration.test.ts`
  asserts an `editor` is rejected from `approveDraft` and receives an empty
  `listThreads`, while `admin` succeeds. The existing inbox suites' session mocks
  were updated to establish an admin (and to still exercise the
  not-authenticated path).
- If a support-agent role is later wanted, introduce `inbox:respond` in the
  `Permission` union and swap the inbox gate from `organization:manage` to it.
