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
 *   - any other capture FAILS CLOSED to the shared-inbox readers: a Postbox
 *     capture stored before its mailbox was recorded, and one stored before
 *     `captureSource` existed at all, which carries only
 *     `sourceType: 'email_attachment'`. Migration 0069 gives back the ones
 *     whose source it can resolve; the Message-ID alone is not guessed from
 *     (the same message can land in several mailboxes).
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { getSingletonOrganizationId, type MutationSessionContext } from './sessionOrganization';
import { createMailboxAccessGate, personalMailEnabled } from '../mail/permissions';
import { isSharedInboxReader } from '../inbox/access';

type FileAccessFields = Pick<
	Doc<'semanticFiles'>,
	'sourceType' | 'captureSource' | 'sourceMailboxId'
>;

/**
 * Whether a Files row was captured from inbound mail and so keeps its
 * mailbox's permission. `sourceType: 'email_attachment'` alone counts: rows
 * captured before `captureSource` existed carry nothing else.
 */
export function isMailCapture(
	file: Pick<Doc<'semanticFiles'>, 'sourceType' | 'captureSource'>
): boolean {
	return file.captureSource !== undefined || file.sourceType === 'email_attachment';
}

/**
 * Which mail captures a session-less search may return — the retrieval
 * counterpart of the read check below, for the actions that have no session
 * to ask (`semanticFileProcessing.semanticSearch`). Absent means 'none', so a
 * caller that does not name a scope cannot widen anything:
 *   - 'none'       → no mail captures (a member's assistant, a Postbox draft,
 *                    whose own mailbox's attachments come from that mailbox);
 *   - 'team_inbox' → Team Inbox captures only (the Team Inbox agent);
 *   - 'all'        → what a shared-inbox reader may open: every capture whose
 *                    mailbox, if recorded, is active, in this organization,
 *                    with personal mail on (as `semanticFiles.get` decides).
 */
export const mailCaptureScopeValidator = v.union(
	v.literal('none'),
	v.literal('team_inbox'),
	v.literal('all')
);
export type MailCaptureScope = Infer<typeof mailCaptureScopeValidator>;

/**
 * The retrieval check for one query: `canRetrieve(file)` under `scope`. Under
 * 'all' a Postbox capture's mailbox is checked exactly as the mailbox gate
 * checks it for an owner/admin; decisions are memoized per mailbox.
 */
export function semanticFileRetrievalGate(
	ctx: QueryCtx,
	scope: MailCaptureScope
): (file: FileAccessFields) => Promise<boolean> {
	let enabled: Promise<boolean> | undefined;
	let organizationId: Promise<string> | undefined;
	const mailboxes = new Map<Id<'mailboxes'>, Promise<boolean>>();
	const isMailboxOpen = async (mailboxId: Id<'mailboxes'>): Promise<boolean> => {
		enabled ??= personalMailEnabled(ctx);
		organizationId ??= getSingletonOrganizationId(ctx);
		if (!(await enabled)) return false;
		const mailbox = await ctx.db.get(mailboxId);
		return mailbox?.status === 'active' && mailbox.organizationId === (await organizationId);
	};
	return async (file) => {
		if (!isMailCapture(file)) return true;
		if (scope === 'none') return false;
		if (scope === 'team_inbox') return file.captureSource === 'team_inbox';
		if (file.captureSource === 'mailbox' && file.sourceMailboxId) {
			const id = file.sourceMailboxId;
			let decision = mailboxes.get(id);
			if (!decision) mailboxes.set(id, (decision = isMailboxOpen(id)));
			return decision;
		}
		return true;
	};
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
