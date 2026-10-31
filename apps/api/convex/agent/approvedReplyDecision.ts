/**
 * The decisions of `agentPipeline.sendApprovedReply`, as data. The action
 * loads the message and the sending identity, asks these functions what to
 * do, and makes every write itself; nothing here reads or writes the database.
 *
 *   1. `routeApprovedReply`: stop, fail, hand off to a channel, or reply by
 *      email to the recipient it resolved.
 *   2. `planEmailReply`: the envelope the send intake gets (subject,
 *      threading headers, rendered body), after the reference monitor on the
 *      autonomous path.
 *   3. `settleIntakeOutcome`: what the intake's answer means for the inbound
 *      message (wait for a file copy, fail, archive, or leave it to the Send
 *      completion).
 */

import { replyBodyToHtml } from '@owlat/shared/html';
import type { Doc, Id } from '../_generated/dataModel';
import type { NonCampaignIntakeRejectionReason } from '../delivery/nonCampaignIntake';
import type { AgentReplyIntakeOutcome } from '../inbox/replyAttachments';
import { isOutboundChannel, type OutboundChannel } from '../lib/convexValidators';
import { buildReplySubject } from '../lib/emailAddress';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { isValidEmail } from '../lib/inputGuards';
import { runReferenceMonitor } from './referenceMonitor';
import { buildThreadingHeaders, extractRecipient } from './replyEnvelope';

/**
 * An autonomous reply whose file answer is still being copied waits this long
 * between tries, at most this many times (two minutes, well inside the
 * stuck-approved reconcile's ten), then stops for a person.
 */
export const ATTACHMENT_WAIT_MS = 5_000;
export const MAX_ATTACHMENT_WAITS = 24;

/**
 * How each typed refusal from the Non-campaign send intake terminates the
 * inbound message. The `Record` makes a new rejection reason a compile error
 * here instead of a refusal flattened into a fault.
 *
 *   - `recipient_blocked` → `archived` with reason `sender_blocked`, the same
 *     edge `inbox/messages.ts` uses when blocklisted mail arrives: the same
 *     verdict about the same address, observed at reply time. `archived` is
 *     terminal, so the failed-action retry cron never re-drives it (`failed`
 *     would report a policy decision as a fault and retry it forever).
 *   - `no_delivery_provider` / `abuse_blocked` are about the deployment, not
 *     the recipient: the draft should send once an operator configures a
 *     provider or the suspension lifts, so they stay `failed`, keep surfacing
 *     as a fault, and stay re-drivable.
 */
const REPLY_REFUSAL_BY_REASON: Record<
	NonCampaignIntakeRejectionReason,
	| { terminal: 'archived'; archiveReason: 'sender_blocked' }
	| { terminal: 'failed'; message: (detail: string | undefined) => string }
> = {
	recipient_blocked: { terminal: 'archived', archiveReason: 'sender_blocked' },
	// Contact-level marketing eligibility gates marketing-scope kinds only, so an
	// agent reply never receives it; mapped like a block for totality.
	recipient_ineligible: { terminal: 'archived', archiveReason: 'sender_blocked' },
	no_delivery_provider: {
		terminal: 'failed',
		message: (detail) => detail ?? 'No delivery provider configured',
	},
	abuse_blocked: {
		terminal: 'failed',
		message: () => 'Sending is disabled while this instance is suspended.',
	},
};

/** The message fields the decisions read. */
export type ApprovedReplyMessage = Pick<
	Doc<'inboundMessages'>,
	| 'processingStatus'
	| 'draftResponse'
	| 'draftSubject'
	| 'subject'
	| 'to'
	| 'from'
	| 'messageId'
	| 'references'
	| 'threadId'
	| 'contactId'
>;

type Fail = { kind: 'fail'; errorMessage: string };
const fail = (errorMessage: string): Fail => ({ kind: 'fail', errorMessage });

/** The channel adapter's arguments, less the inbound message id the action adds. */
export interface ChannelReplyDispatch {
	channel: OutboundChannel;
	contactId: Id<'contacts'>;
	threadId: Id<'conversationThreads'>;
	content: { text: string; subject?: string };
}

export type ApprovedReplyRoute =
	| { kind: 'stop' }
	| Fail
	| { kind: 'channel'; dispatch: ChannelReplyDispatch }
	| { kind: 'email'; recipient: string; draft: string };

/**
 * Where an approved reply goes. Non-email channels (sms/whatsapp/generic)
 * dispatch through the channel adapter, which drives the message to
 * sent/failed off the real send outcome. An email recipient that does not
 * parse as an address fails rather than being faked as sent.
 */
export function routeApprovedReply(
	message: ApprovedReplyMessage,
	attachmentWaits: number
): ApprovedReplyRoute {
	// A send waiting on a file copy ends once someone pulled the message back.
	if (attachmentWaits > 0 && message.processingStatus !== 'approved') return { kind: 'stop' };
	const draft = message.draftResponse;
	if (!draft) return fail('No draft to send');
	if (isOutboundChannel(message.to)) {
		if (!message.threadId || !message.contactId) {
			return fail(`Channel reply (${message.to}) is missing its thread or contact`);
		}
		const subject = message.draftSubject ? { subject: message.draftSubject } : {};
		return {
			kind: 'channel',
			dispatch: {
				channel: message.to,
				contactId: message.contactId,
				threadId: message.threadId,
				content: { text: draft, ...subject },
			},
		};
	}
	// The inbound `from` is "Name <email>"; the reply goes back to that address.
	const recipient = extractRecipient(message.from);
	if (!recipient || !isValidEmail(recipient)) {
		return fail(`Unsupported or invalid reply recipient: "${message.from}"`);
	}
	return { kind: 'email', recipient, draft };
}

/** The org sending identity: `instanceSettings.defaultFrom*`, else the env defaults. */
export interface ReplySender {
	fromEmail?: string;
	fromName?: string;
}

/** `inbox/replyAttachments.intakeAgentReply`'s envelope arguments. */
export interface AgentReplyEnvelope {
	email: string;
	contactId?: Id<'contacts'>;
	subject: string;
	html: string;
	draftText: string;
	from: string;
	headers?: Record<string, string>;
}

export type EmailReplyPlan = Fail | { kind: 'intake'; envelope: AgentReplyEnvelope };

/**
 * The envelope of an email reply. The subject prefers the agent's
 * `draftSubject` (already "Re: ..."); the RFC 5322 threading headers land the
 * reply under the customer's message.
 *
 * Autonomous sends only: the deterministic reference monitor re-derives the
 * authenticated recipient and requires the resolved target to match it, runs
 * a local DLP pass over the draft, and strips remote images and off-allowlist
 * link hosts from the HTML. A recipient-lock or DLP violation fails closed:
 * the draft stays on the message and nothing is sent. Human-reviewed sends
 * bypass the monitor.
 */
export function planEmailReply(
	message: ApprovedReplyMessage,
	route: { recipient: string; draft: string },
	sender: ReplySender,
	autonomous: boolean
): EmailReplyPlan {
	const { fromEmail } = sender;
	if (!fromEmail) {
		return fail(
			'No sending identity configured — set a default sender email in organization settings.'
		);
	}
	const subject =
		message.draftSubject ??
		(message.subject ? buildReplySubject(message.subject) : 'Re: your message');
	const headers = buildThreadingHeaders({
		messageId: message.messageId,
		references: message.references,
	});
	let html = replyBodyToHtml(route.draft);
	if (autonomous) {
		const monitor = runReferenceMonitor({
			inboundFrom: message.from,
			resolvedRecipient: route.recipient,
			draftText: route.draft,
			draftHtml: html,
			allowedLinkHosts: [fromEmail.slice(fromEmail.indexOf('@') + 1)],
		});
		if (!monitor.ok) return fail(monitor.reason);
		html = monitor.html;
	}
	return {
		kind: 'intake',
		envelope: {
			email: route.recipient,
			...(message.contactId ? { contactId: message.contactId } : {}),
			subject,
			html,
			draftText: route.draft,
			from: formatFromAddress(fromEmail, sender.fromName),
			...(Object.keys(headers).length > 0 ? { headers } : {}),
		},
	};
}

export type IntakeSettlement =
	| { kind: 'hold'; attachmentWaits: number; delayMs: number }
	| Fail
	| { kind: 'archive'; reason: 'sender_blocked'; refusal: NonCampaignIntakeRejectionReason }
	| { kind: 'enqueued'; sendId: Id<'transactionalSends'> };

/**
 * What the intake's answer means for the inbound message. Enqueued: the
 * message stays `approved` until the Send completion drives it to sent or
 * failed. A file still being copied is a queued send like the undo window, so
 * it waits (Undo, a landing reply or the kill switch can still stop it) until
 * the waits run out.
 */
export function settleIntakeOutcome(
	outcome: AgentReplyIntakeOutcome,
	attachmentWaits: number
): IntakeSettlement {
	if (outcome.ok) return { kind: 'enqueued', sendId: outcome.sendId };
	switch (outcome.reason) {
		case 'attachment_copying':
			return attachmentWaits < MAX_ATTACHMENT_WAITS
				? { kind: 'hold', attachmentWaits: attachmentWaits + 1, delayMs: ATTACHMENT_WAIT_MS }
				: fail('A file for this reply is still being attached. Review and send it by hand.');
		case 'attachment_failed':
			return fail('A file for this reply could not be attached. Review and send it by hand.');
		case 'item_coverage':
		case 'interpretation_incomplete':
			return fail(outcome.detail);
	}
	const refusal = REPLY_REFUSAL_BY_REASON[outcome.reason];
	if (refusal.terminal === 'failed') return fail(refusal.message(outcome.detail));
	return { kind: 'archive', reason: refusal.archiveReason, refusal: outcome.reason };
}
