# ADR-0064: Saved replies grow out of mailbox snippets

## Status

Accepted.

## Context

The Postbox had per-mailbox snippets (`mailSnippets`, `mail/snippets.ts`):
a name, a shortcut, sanitized HTML, typed variables, a `/` trigger in the
simple editor. The Team Inbox reply had nothing, and a snippet could not be
shared with the team or kept by a person across their mailboxes. Saved replies
needed a person scope, a team scope that admins curate and that can be limited
to some team inboxes, usage counts, both composers, and erasure and export.

A second table beside `mailSnippets` would have been two mechanisms for one
thing, with two pickers and two management pages.

## Decision

### 1. One table, three readings

`mailSnippets` stays the store; the rows gain optional fields: `scope`
(`personal` | `shared`), `ownerUserId` (personal), `organizationId`,
`mailboxIds` (the team inboxes a shared reply is limited to), `authorUserId`
(who wrote a shared reply), `useCount`, `lastUsedAt`. `mailboxId` becomes
optional. All of it is additive; old rows validate.

A row without `scope` was written before saved replies. It is read through its
mailbox (`mail/savedReplyRules.ts:savedReplyScope`): on a personal mailbox it
is its owner's personal reply, on a team inbox it is a shared reply limited to
that inbox, on a seed or a missing mailbox it is nobody's and shows nowhere.
Migration 0060 writes exactly that onto each row. Because every reader applies
the same rule, the migration is optional and nothing waits on it; it only
moves the rows into the owner and organization indexes. A row's first edit
writes its scope too.

### 2. Who sees and who changes

Personal: the owner only, in every composer. Shared: every member of the
organization, or, when limited, only composers writing from one of those team
inboxes (never the Team Inbox reply, which has no mailbox). Changing a shared
reply needs `settings:manage`; everyone may insert one. A limit can only name
live team inboxes of the organization; anything else is refused, never
dropped, so a limit can not silently widen to "everywhere".

This narrows one old permission: a member of a team inbox could edit that
inbox's snippets, and can no longer. The previous release's API
(`mail/snippets.ts`) applies the new rules for the one release it is kept.

### 3. Functions and floor

`mail/savedReplies.ts` serves both composers, so its builders are
`featureGatedAny(…, ['postbox', 'mail.external', 'inbox'])`: a Team-Inbox-only
instance has saved replies. Usage is recorded by a separate `recordUse`
mutation after an insert; a failed count never gets in the way of the reply.

### 4. Variables and gaps are resolved in the composer

Nothing on the send path reads saved replies. The composer resolves
`{{contact.firstName}}`-style variables at insertion against what it knows. The
shared template grammar (`@owlat/shared/templateVariables`) stays `\w+`-only,
since the send path personalizes with it; dotted names are rewritten into it
locally before the walk.

An unresolved variable becomes a `[[...]]` gap, the placeholder AI drafts
already use. The composer holds Send while gaps remain once a saved reply put
one in; in the Postbox the draft is marked `isGapGuarded`, so the server's
`DRAFT_HAS_GAPS` check applies and survives a reload. The Team Inbox reply has
no draft row, so there the hold is the composer's.

### 5. Erasure and export

A member's personal replies are deleted with the member's other records; the
shared replies they wrote stay and lose `authorUserId` in a new phase
appended to the member erasure (`savedReplyAuthorship`). Personal replies are a
personal resource of the account export (`savedReplies`). Workspace deletion
already sweeps the table.

## Consequences

- The table name no longer says what it holds; the schema comment does.
- Legacy-row reading stays until a later release drops it, after 0060 has run
  everywhere (a contract step that needs the migration record).
- Usage counts on a shared reply are the team's, not the person's, so the
  picker orders shared replies by what the team uses.
