/**
 * The compose seed for a reply, reply-all or forward of one message: quoting,
 * recipients, subject prefix and the reply-all hint.
 *
 * One builder for every place a reply starts, so a draft opened from the
 * reader, from Answer mode's own URL (a reload, a notification) or from an AI
 * suggestion carries the same quote and the same recipients.
 */
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';
import { deriveReplyAllExtras } from '~/utils/recipientHints';
import { resolvePrimaryReplyKind, type PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import type { AnswerModeKind } from '~/utils/answerMode';
import type { ComposeSpec } from './usePostboxComposeNav';
import {
	buildForwardedBody,
	buildReplySpec,
	forwardAttachmentsSeed,
	resolveBodyFields,
	type ForwardableParts,
} from './usePostboxQuotedText';

/** The reply/forward source shape the composer quotes from. */
export type ReplyForwardSource = {
	_id: string;
	subject: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
	/** Its parts: a forward copies the ones `isForwardedPart` picks. */
	attachments?: ForwardableParts;
};

/** A seed for the composer. */
export type ReplyComposeSeed = ComposeSpec;

type RecipientFields = { fromAddress: string; toAddresses: string[]; ccAddresses: string[] };

/** Whether Reply-All would add anyone beyond a plain Reply (extra To/Cc). */
export function replyAllAddsRecipients(
	msg: RecipientFields,
	ownAddresses: ReadonlySet<string>
): boolean {
	const seen = new Set<string>([extractEmailAddress(msg.fromAddress), ...ownAddresses]);
	return [...msg.toAddresses, ...msg.ccAddresses].some((a) => {
		const c = extractEmailAddress(a);
		return c.length > 0 && !seen.has(c);
	});
}

/**
 * The kind the PRIMARY reply (the Reply button, `r`) opens: the person's
 * default reply mode, collapsing to a plain reply when reply-all would add no
 * one. The explicit Reply-all (`a`) bypasses this.
 */
export function primaryReplyKindFor(
	mode: PostboxReplyDefaultMode,
	msg: RecipientFields,
	ownAddresses: ReadonlySet<string>
): 'reply' | 'replyAll' {
	return resolvePrimaryReplyKind(mode, replyAllAddsRecipients(msg, ownAddresses));
}

/**
 * The one-time seed for `kind` of `source`. The body is resolved first (a body
 * over the inline threshold lives in blob storage). `leadText` (an AI
 * suggestion) goes above the quote of a reply.
 */
export async function buildReplyComposeSeed(
	kind: AnswerModeKind,
	source: ReplyForwardSource,
	ctx: { mailboxId: Id<'mailboxes'>; ownAddresses: ReadonlySet<string>; leadText?: string }
): Promise<ReplyComposeSeed> {
	const target = await resolveBodyFields(source);
	if (kind === 'forward') {
		return {
			mailboxId: ctx.mailboxId,
			prefillSubject: target.subject.match(/^fwd?\s*:\s*/i)
				? target.subject
				: `Fwd: ${target.subject}`,
			prefillBodyHtml: buildForwardedBody(target),
			...forwardAttachmentsSeed(target),
		};
	}
	const spec: ReplyComposeSeed = buildReplySpec(ctx.mailboxId, target, ctx.leadText);
	const extras = deriveReplyAllExtras(target, [...ctx.ownAddresses]);
	if (kind === 'replyAll') {
		spec.prefillCc = extras;
	} else if (extras.length > 0) {
		// Surface the "Also include …?" gap hint in the composer.
		spec.replyAllRecipients = extras;
	}
	return spec;
}
