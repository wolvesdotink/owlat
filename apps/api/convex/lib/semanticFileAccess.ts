/**
 * Who may read a row in Files (`semanticFiles`).
 *
 * Files a person put there (an upload, an Answer mode file kept in Files, an
 * agent artifact) are readable by every organization member: the Files page
 * lists them all. A file CAPTURED FROM INBOUND MAIL is not. It is an
 * attachment of a message in a mailbox, and it keeps that mailbox's
 * permission, or else capturing it would publish a private Postbox or the
 * owner/admin-only Team Inbox (ADR-0040) to every member through Files:
 *
 *   - a Postbox capture with its mailbox recorded (`sourceMailboxId`): the
 *     mailbox gate (mail/permissions.ts), so its own user, a member of a
 *     shared mailbox, or an owner/admin, while the mailbox is active and
 *     personal mail is on;
 *   - a Team Inbox capture: the shared-inbox reader rule (inbox/access.ts);
 *   - a Postbox capture from before the mailbox was recorded: FAILS CLOSED to
 *     the shared-inbox readers. Its mailbox cannot be told from the Message-ID
 *     alone (the same message can land in several mailboxes), and owners and
 *     admins could open any of the org's mailboxes anyway.
 *
 * `captureSource` is set only by the inbound capture path, so it is the one
 * marker; `sourceMailboxId` only narrows a Postbox capture back to its readers.
 */

import { v, type Infer } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { MutationSessionContext } from './sessionOrganization';
import { createMailboxAccessGate } from '../mail/permissions';
import { isSharedInboxReader } from '../inbox/access';

type FileAccessFields = Pick<Doc<'semanticFiles'>, 'captureSource' | 'sourceMailboxId'>;

/** Whether a Files row was captured from inbound mail and so keeps its mailbox's permission. */
export function isMailCapture(file: Pick<Doc<'semanticFiles'>, 'captureSource'>): boolean {
	return file.captureSource !== undefined;
}

/**
 * Which mail captures a session-less search may return — the retrieval
 * counterpart of the read check below, for the actions that have no session
 * to ask (`semanticFileProcessing.semanticSearch`). REQUIRED there, like
 * `scopeToContact`, so a forgotten argument cannot widen anything:
 *   - 'none'       → no mail captures (a member's assistant, a Postbox draft,
 *                    whose own mailbox's attachments come from that mailbox);
 *   - 'team_inbox' → Team Inbox captures only (the Team Inbox agent);
 *   - 'all'        → every capture (a shared-inbox reader, who may open every
 *                    mailbox of the org).
 */
export const mailCaptureScopeValidator = v.union(
	v.literal('none'),
	v.literal('team_inbox'),
	v.literal('all')
);
export type MailCaptureScope = Infer<typeof mailCaptureScopeValidator>;

/** Whether a search under `scope` may return this file. */
export function isInMailCaptureScope(
	file: Pick<Doc<'semanticFiles'>, 'captureSource'>,
	scope: MailCaptureScope
): boolean {
	if (!isMailCapture(file) || scope === 'all') return true;
	return scope === 'team_inbox' && file.captureSource === 'team_inbox';
}

/**
 * The read check for one handler invocation: `canReadSemanticFile(file)`.
 * Mailbox decisions are memoized per mailbox (createMailboxAccessGate), so a
 * page of captures from one mailbox costs one gate. Callers treat `false` as
 * absent: drop the row from a list, return null for a point read.
 */
export function semanticFileReadGate(
	ctx: QueryCtx,
	session: MutationSessionContext
): (file: FileAccessFields) => Promise<boolean> {
	const mailboxGate = createMailboxAccessGate(ctx, session);
	return async (file) => {
		if (!isMailCapture(file)) return true;
		if (file.captureSource === 'mailbox' && file.sourceMailboxId) {
			return (await mailboxGate(file.sourceMailboxId)).ok;
		}
		return isSharedInboxReader(session);
	};
}
