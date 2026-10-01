/**
 * Where a composer's message goes, and what that destination lets it do.
 *
 * Owlat has two composers for one job. The Postbox composer writes into a
 * mailbox: a `mailDrafts` row that autosaves, an editable envelope, send-as
 * identities, signatures, attachments, scheduling, Sealed Mail and the
 * recipient guards, all keyed by `mailboxId`. The Team inbox reply box answers
 * one inbound message: plain text saved on the message itself
 * (`inboundMessages.draftResponse`), sent through `approveDraft` or, once the
 * message was answered, `inbox/followUps.sendFollowUp`. The recipient is fixed
 * (whoever wrote in) and the address it goes out from is the inbox's own.
 *
 * A composer target names the destination. Everything that differs between
 * the two follows from its `kind` through {@link composerTargetCapabilities},
 * so a surface asks "does this target take attachments?" rather than "am I the
 * thread page?". Both composers render inside the same frame
 * (`PostboxComposerShell`), and the shared footer reads the table to leave out
 * the controls a target cannot use. Pure: no Vue, no Convex, no i18n.
 */

import type { Id } from '@owlat/api/dataModel';
import { replyBodyToHtml } from '@owlat/shared/html';
import { preflightDraft, type PreflightFinding } from '~/utils/postboxPreflight';

export type ComposerTarget = MailboxComposerTarget | TeamThreadComposerTarget;

/** A message written in a mailbox: a `mailDrafts` row, sent by `mail.drafts.send`. */
export interface MailboxComposerTarget {
	kind: 'mailbox';
	mailboxId: Id<'mailboxes'>;
	/** Reopen an existing draft (continue editing, after undo-send). */
	draftId?: Id<'mailDrafts'>;
	inReplyToMessageId?: Id<'mailMessages'>;
}

/** The reply to one inbound message on a Team inbox thread. */
export interface TeamThreadComposerTarget {
	kind: 'teamThread';
	threadId: Id<'conversationThreads'>;
	/** The message the reply answers (the newest waiting one, or one picked). */
	inboundMessageId: Id<'inboundMessages'>;
}

/**
 * What a target supports. Every flag reads "the composer may offer this".
 *
 * The shared footer (`PostboxComposerFooter`) hides the send-as name, the
 * paperclip, scheduling, the reply reminder, the signature picker and the
 * rich-body tools by these flags, and the shell (`PostboxComposerShell`) takes
 * file drops only where `attachments` is the composer's own.
 * {@link composerPreflight} reads `body`, `preflight` and `subjectFallback`.
 * `envelope`, `sendAs`, `seal` and `recipientGuards` describe the mailbox
 * composer's own envelope, seal lock and guards, which a team reply never
 * mounts.
 */
export interface ComposerTargetCapabilities {
	/**
	 * The body the target stores and sends. `text` is escaped into HTML on the
	 * way out (`replyBodyToHtml` in `@owlat/shared/html`), so formatting would be lost.
	 */
	body: 'html' | 'text';
	/**
	 * `autosave` writes a draft row as the person types; `explicit` keeps the
	 * text in the composer until they save or send it.
	 */
	persistence: 'autosave' | 'explicit';
	/** To / Cc / Bcc can be edited. A team reply always goes to the sender. */
	envelope: boolean;
	/** The From address can be picked, and signatures are per identity. */
	sendAs: boolean;
	signatures: boolean;
	/**
	 * Where files ride along. `draft`: on the draft row, uploaded by the
	 * composer itself (the paperclip, drops and pastes). `thread`: on the Team
	 * inbox thread (`inbox.replyAttachments`), through the attachment panel the
	 * host puts under the editor; the composer offers no upload of its own.
	 */
	attachments: 'draft' | 'thread';
	/** The send can be scheduled for later. */
	schedule: boolean;
	/** "Remind me if no reply by …", kept on the draft row. */
	replyReminder: boolean;
	/** Sealed Mail's per-recipient encryption state applies. */
	seal: boolean;
	/** First-time-recipient and domain-alignment checks (mailbox-keyed queries). */
	recipientGuards: boolean;
	/** The deterministic pre-send checks (`utils/postboxPreflight`). */
	preflight: boolean;
	/** A blank subject goes out as "Re: …" (the server fills it in). */
	subjectFallback: boolean;
	/** The body may arrive pre-filled by the agent, with an edit diff against it. */
	agentDraft: boolean;
}

const MAILBOX: ComposerTargetCapabilities = {
	body: 'html',
	persistence: 'autosave',
	envelope: true,
	sendAs: true,
	signatures: true,
	attachments: 'draft',
	schedule: true,
	replyReminder: true,
	seal: true,
	recipientGuards: true,
	preflight: true,
	subjectFallback: false,
	agentDraft: false,
};

const TEAM_THREAD: ComposerTargetCapabilities = {
	body: 'text',
	persistence: 'explicit',
	envelope: false,
	sendAs: false,
	signatures: false,
	attachments: 'thread',
	schedule: false,
	replyReminder: false,
	seal: false,
	recipientGuards: false,
	preflight: true,
	subjectFallback: true,
	agentDraft: true,
};

/** The mailbox target a composer seed opens on (its location fields, named). */
export function mailboxComposerTarget(
	location: Omit<MailboxComposerTarget, 'kind'>
): MailboxComposerTarget {
	return {
		kind: 'mailbox',
		mailboxId: location.mailboxId,
		draftId: location.draftId,
		inReplyToMessageId: location.inReplyToMessageId,
	};
}

export function composerTargetCapabilities(target: ComposerTarget): ComposerTargetCapabilities {
	switch (target.kind) {
		case 'mailbox':
			return MAILBOX;
		case 'teamThread':
			return TEAM_THREAD;
	}
}

/**
 * The body as the HTML the checks written for the Postbox composer read. A
 * plain-text body goes through the same `replyBodyToHtml` the server sends it
 * with, so a check sees what the recipient will get.
 */
function bodyHtml(body: string, format: ComposerTargetCapabilities['body']): string {
	return format === 'html' ? body : replyBodyToHtml(body);
}

/**
 * The pre-send checks that apply to a draft for this target. Advisory, like
 * everywhere else they show: the findings never block a send.
 */
export function composerPreflight(
	target: ComposerTarget,
	draft: { subject: string; body: string }
): PreflightFinding[] {
	const capabilities = composerTargetCapabilities(target);
	if (!capabilities.preflight) return [];
	const findings = preflightDraft({
		subject: draft.subject,
		bodyHtml: bodyHtml(draft.body, capabilities.body),
	});
	// Nothing goes out without a subject when the server supplies one.
	return capabilities.subjectFallback
		? findings.filter((finding) => finding.id !== 'emptySubject')
		: findings;
}
