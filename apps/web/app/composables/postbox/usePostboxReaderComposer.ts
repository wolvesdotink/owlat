import type { ComputedRef, Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import type { AnswerModeKind } from '~/utils/answerMode';
import { useAnswerModeNav, useAnswerPendingLead } from '~/composables/useAnswerMode';
import {
	buildReplyComposeSeed,
	primaryReplyKindFor,
	replyAllAddsRecipients,
	type ReplyForwardSource,
} from './postboxReplySpec';
import { buildResendSpec, resolveBodyFields } from './usePostboxQuotedText';

/** The open reader message — a reply source plus the routing/identity fields. */
type ReaderComposerMessage = ReplyForwardSource & { mailboxId: string; threadId?: string };

/**
 * The reply / reply-all / forward verbs of the thread reader. Every one of
 * them opens Answer mode (plan decision 2: every reply, no inline box); only
 * the delivery strip's resend, which is not a reply, opens the compose page.
 *
 * `getMessage` returns the currently open message; `latestMessage` /
 * `ownAddresses` / `replyDefault` are the reader's live derived state, passed in
 * rather than re-derived so this composable is a pure view over them.
 *
 * `guardReply` (optional) wraps a reply/reply-all with the sender-auth reply
 * guard (Sealed Mail A3). The keyboard paths (`r`/`a` against the latest
 * message) go through it here; the per-message buttons are guarded by the
 * reader itself. Forward is never guarded. Answer mode runs the same guard
 * again on its own URL (a deep link skips the reader), and a thread already
 * confirmed here passes straight through there.
 */
export function usePostboxReaderComposer(opts: {
	getMessage: () => ReaderComposerMessage;
	latestMessage: ComputedRef<ReplyForwardSource | undefined>;
	ownAddresses: ComputedRef<Set<string>>;
	replyDefault: Ref<PostboxReplyDefaultMode> | ComputedRef<PostboxReplyDefaultMode>;
	guardReply?: (run: () => void) => void;
}) {
	const { getMessage, latestMessage, ownAddresses, replyDefault } = opts;
	const guardReply = opts.guardReply ?? ((run: () => void) => run());
	const { t } = useI18n();
	const composeNav = usePostboxComposeNav();
	const answerNav = useAnswerModeNav();
	const pendingLead = useAnswerPendingLead();

	const createDraft = useBackendOperation(api.mail.drafts.create, {
		label: () => t('shared.postbox.usePostboxCompose.createOperation'),
	});
	const updateDraft = useBackendOperation(api.mail.drafts.update, {
		label: () => t('shared.postbox.usePostboxCompose.saveOperation'),
	});

	function openAnswer(source: ReplyForwardSource, kind: AnswerModeKind | null) {
		void answerNav.open(source._id, { kind });
	}

	/** Whether Reply-All would add anyone beyond a plain Reply (extra To/Cc). */
	function hasOtherRecipients(msg: ReplyForwardSource) {
		return replyAllAddsRecipients(msg, ownAddresses.value);
	}

	/** The primary reply (Reply button / `r`): the person's default reply mode. */
	function openPrimaryReply(replyTo?: ReplyForwardSource) {
		const source = replyTo ?? getMessage();
		openAnswer(source, primaryReplyKindFor(replyDefault.value, source, ownAddresses.value));
	}

	function openReplyAll(replyTo?: ReplyForwardSource) {
		openAnswer(replyTo ?? getMessage(), 'replyAll');
	}

	function openForward(msg?: ReplyForwardSource) {
		openAnswer(msg ?? getMessage(), 'forward');
	}

	/**
	 * A reply seeded with an AI-suggested body (a suggestion card, the
	 * scheduling chip). The draft is created WITH the body before Answer mode
	 * opens on it (`?draft=`), so a reload keeps the suggestion. Should the row
	 * not be created, Answer mode still opens and takes the text from session
	 * state instead: the suggestion is never lost to a failed round trip.
	 */
	async function openReplyWithBody(replyTarget: ReplyForwardSource, bodyText: string) {
		const mailboxId = getMessage().mailboxId as Id<'mailboxes'>;
		const seed = await buildReplyComposeSeed('reply', replyTarget, {
			mailboxId,
			ownAddresses: ownAddresses.value,
			leadText: bodyText,
		});
		const created = await createDraft.run({
			mailboxId,
			inReplyToMessageId: replyTarget._id as Id<'mailMessages'>,
		});
		if (created.ok) {
			const draftId = created.result.draftId as Id<'mailDrafts'>;
			const saved = await updateDraft.run({
				draftId,
				toAddresses: seed.prefillTo ?? [],
				ccAddresses: seed.prefillCc ?? [],
				subject: seed.prefillSubject ?? '',
				bodyHtml: seed.prefillBodyHtml ?? '',
				composerMode: 'simple',
			});
			if (saved.ok) {
				void answerNav.open(replyTarget._id, { kind: 'reply', draftId });
				return;
			}
		}
		pendingLead.set(replyTarget._id, bodyText);
		openAnswer(replyTarget, 'reply');
	}

	/**
	 * Open a composer that resends `source` to `addresses` only — the delivery
	 * strip's "resend to the failed recipient" action (plan idea 1). Not a
	 * reply, so it opens the compose page. A call with no addresses is a no-op.
	 */
	async function openResend(source: ReplyForwardSource, addresses: string[]) {
		if (addresses.length === 0) return;
		const target = await resolveBodyFields(source);
		void composeNav.open(
			buildResendSpec(getMessage().mailboxId as Id<'mailboxes'>, target, addresses)
		);
	}

	// Keyboard entry points (`r` / `a` / `f`, the ⌘K bridge): against the
	// thread's LATEST message, reply and reply-all behind the guard.
	function replyToLatest() {
		const target = latestMessage.value;
		if (target) guardReply(() => openPrimaryReply(target));
	}
	function replyAllToLatest() {
		const target = latestMessage.value;
		if (target) guardReply(() => openReplyAll(target));
	}
	function forwardLatest() {
		const target = latestMessage.value;
		if (target) openForward(target);
	}

	return {
		openReplyAll,
		openPrimaryReply,
		openReplyWithBody,
		openForward,
		openResend,
		hasOtherRecipients,
		replyToLatest,
		replyAllToLatest,
		forwardLatest,
	};
}
