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
 * thread page?". Pure: no Vue, no Convex, no i18n.
 */

import type { Id } from '@owlat/api/dataModel';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import { preflightDraft, type PreflightFinding } from '~/utils/postboxPreflight';

export type ComposerTarget =
	| {
			kind: 'mailbox';
			mailboxId: Id<'mailboxes'>;
			/** Reopen an existing draft (continue editing, after undo-send). */
			draftId?: Id<'mailDrafts'>;
			inReplyToMessageId?: Id<'mailMessages'>;
	  }
	| TeamThreadComposerTarget;

/** The reply to one inbound message on a Team inbox thread. */
export interface TeamThreadComposerTarget {
	kind: 'teamThread';
	threadId: Id<'conversationThreads'>;
	/** The message the reply answers (the newest waiting one, or one picked). */
	inboundMessageId: Id<'inboundMessages'>;
}

/** What a target supports. Every flag reads "the composer may offer this". */
export interface ComposerTargetCapabilities {
	/**
	 * The body the target stores and sends. `text` is escaped into HTML on the
	 * way out (the server's `replyBodyToHtml`), so formatting would be lost.
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
	/** Files can ride along. Team replies have no storage for them yet. */
	attachments: boolean;
	/** The send can be scheduled for later. */
	schedule: boolean;
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
	attachments: true,
	schedule: true,
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
	attachments: false,
	schedule: false,
	seal: false,
	recipientGuards: false,
	preflight: true,
	subjectFallback: true,
	agentDraft: true,
};

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
 * plain-text body is escaped the way the server escapes it for sending
 * (`agent/replyEnvelope.replyBodyToHtml`), so a check sees what the recipient
 * will get.
 */
function bodyHtml(body: string, format: ComposerTargetCapabilities['body']): string {
	if (format === 'html') return body;
	return `<div>${escapeHtmlWithBreaks(body.replace(/\r\n/g, '\n'))}</div>`;
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
