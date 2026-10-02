# ADR-0071: Email co-editing, a shared session edited block by block

## Status

Accepted.

## Context

The block builder was single-user. Each tab held its own draft and Save wrote
the whole document. The content revision (`lib/contentRevision.ts`) stopped a
stale tab from silently overwriting a newer save, but the result was a
conflict dialog every time two people touched the same email: "keep my
version" or "load the latest", whole document against whole document. Two
people could not work on one campaign at once. The shared inbox already had
presence (`inbox/presence.ts`); the editor had nothing like it.

## Decision

### 1. One shared session per email, separate from the email row

While anyone edits an email template (which is also every campaign's
content) or a transactional email, its editor state lives in one
`emailCoeditSessions` row: the root blocks, the shared fields (name,
subject, text/plain override; for transactional emails also attachments and
the unsubscribe toggle), a `version` and a `savedVersion`. The email row
keeps its meaning: it is what Save, publish, sends, version history and
translations read. The session is a draft every editor shares.

Editing the row directly (autosave) was rejected: every keystroke batch
would re-render the HTML, write a version-history snapshot and an audit-log
entry, and change what a scheduled send or a published transactional email
uses mid-edit. The explicit Save, publish and history flows stay as they
were.

`open` creates the session from the row. A session with nothing unsaved
follows the row when it changes elsewhere (the translations page, an API
write): the editor calls `open` again and the session is reseeded. One with
unsaved changes is left alone; its next save meets the existing
stale-revision conflict dialog, where "keep my version" saves the session
over the row and "load the latest" resets the session (`reset`).

### 2. Operations are per root block

`@owlat/shared/coeditOps` defines the vocabulary: insert, delete, move,
update (the whole root block) and a field write. A nested item (a column, a
container child) is part of its root. The editor never builds operations by
hand: it diffs the last server state against what the canvas shows, so
nothing is queued and a lost or repeated send heals itself
(`apps/web/app/lib/coeditSync.ts`, a differential sync). One batch is in
flight per tab, and the next waits until the session state includes it.

Incoming states are merged by re-applying the tab's unsent edits on top; the
difference is other people's edits, which the builder applies through
`applyRemoteOps`. That path keeps the selection and folds the change into
every recorded undo state (`useHistory.absorb`), so undo and redo walk only
the tab's own steps. Edits to different blocks always merge.

Root-block granularity is the MVP's unit: two people editing different
columns of one columns block edit the same block. Character-level merging
inside one text block is out of scope.

### 3. Leases prevent most same-block conflicts; last writer wins the rest

Presence (`emailEditorPresence`) is a row per open tab with a heartbeat, the
selected root block and an optional edit lease. A tab takes the lease when
its inline text editor opens on a block or when it changes the selected
block, and gives it up when the selection moves, the tab is hidden or
closed. A lease lasts 20 seconds past the last heartbeat. Others see the
block outlined with "Name is editing" and cannot select it. The server does
not enforce leases: a lease race or an offline tab still writes.

So the server decides conflicts per block. Every operation names the
version its tab last saw the block or field at (held from the moment the
lease was taken). If another tab wrote that block later, the incoming write
still wins, and the replaced value is recorded as a notice addressed to the
tab that lost it (`emailCoeditNotices`), with "Put mine back". For a
template, the session as it was before the batch is also captured in
version history with the new `conflict` trigger. Transactional emails have
no version history; their notice carries the replaced value for the restore.

### 4. Saving writes the session

The `update` mutations of both tables take an optional `coeditVersion`.
With it, and a live session, the server saves the session's blocks and
shared fields, not the payload's: an edit that reached the server before the
save is never overwritten by a tab that missed it. The editor first sends
whatever it still has. The content-revision guard is unchanged. Without a
session (it ended) the payload is the draft, as before.

### 5. Lifetime

Presence lives for its 35-second window, notices for an hour, and a session
is dropped an hour after the last person left. The bounded sweep
(`emailCoediting/sweep.ts`) runs at the start of every `open` rather than on
a cron: an editor can then never join a session that should already have
been dropped, and `crons.ts` stays as it is. Unsaved shared changes survive a
reload or a short absence, but do not linger. The unsaved-changes prompt only shows when the
leaving person is the last one in the editor; "discard" then resets the
session. If a tab returns to a session that was swept while it held unsaved
work, it pushes its copy into the new session instead of dropping it.

Deleting the email deletes its session, presence and notices. Workspace
deletion sweeps the three tables; member erasure deletes the member's
presence rows and the notices that name them. No feature flag: co-editing
is how the editor works for members with `templates:manage`; others keep the
classic single-tab draft.

## Consequences

- New tables, an additive union member (`emailTemplateVersions.trigger`)
  and optional arguments only; older clients keep saving the classic way.
- The editor shows a spinner until it has joined the session.
- Text typed in the inline editor reaches the others when the editor closes,
  the same moment it reaches the draft.
- Saved blocks (the block library editor) do not co-edit.
