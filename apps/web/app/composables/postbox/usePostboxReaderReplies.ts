/**
 * Every way PostboxThreadReader starts a reply: the per-message Reply / Reply
 * all / Forward / Resend, a quoted passage, the keyboard and ⌘K paths to the
 * latest message, and files dropped on the conversation. Each opens Answer
 * mode, and every reply / reply-all goes through the sender-auth reply guard.
 */
import { computed, type ComputedRef, type Ref } from 'vue';
import { extractEmailAddress } from '~/utils/emailAddress';
import { deriveReplyRisk, senderRiskInputOf, type ReplyRisk } from '~/utils/senderAuth';
import { replyDropRecipient, type ReplyDropTarget } from '~/utils/replyFileDrop';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import { primaryReplyKindFor } from './postboxReplySpec';
import type { PostboxReaderMessage } from './postboxReaderMessage';

/** The confirm PostboxReplyGuard exposes. */
export type PostboxReplyGuardHandle = {
	guard: (
		threadId: string,
		risk: ReplyRisk | null,
		destination: string,
		action: () => void
	) => void;
};

export function usePostboxReaderReplies(source: {
	message: () => PostboxReaderMessage;
	folderRole: () => string | undefined;
	messages: ComputedRef<PostboxReaderMessage[]>;
	latestMessage: ComputedRef<PostboxReaderMessage | undefined>;
	ownAddresses: ComputedRef<Set<string>>;
	replyDefault: Ref<PostboxReplyDefaultMode>;
	/** The mounted PostboxReplyGuard. */
	guardEl: Ref<PostboxReplyGuardHandle | null>;
	/** The sender-authentication badge flag (`senderAuthBadges`): off, nothing is guarded. */
	guardEnabled: Ref<boolean>;
}) {
	// Reply guard: intercept reply / reply-all with a one-time-per-thread confirm on
	// the sender shapes a reply walks into (UX plan idea 56) — a DMARC failure, a
	// pass belonging to another domain, a look-alike of a known contact's domain, or
	// a Reply-To that redirects elsewhere. Everything else (and a flag-off state)
	// passes straight through; DMARC→Spam routing is untouched.

	/** The reply risk for `msg`, or null when the badge flag is off. */
	function replyRisk(msg: PostboxReaderMessage): ReplyRisk | null {
		if (!source.guardEnabled.value) return null;
		return deriveReplyRisk(senderRiskInputOf(msg));
	}

	/**
	 * Run `action` behind the reply guard for `msg`: a one-time-per-thread confirm
	 * when the sender is in one of the flagged shapes, else straight through. Shared
	 * by every reply/reply-all entry point here (per-message buttons, keyboard, ⌘K)
	 * so none of them can bypass the interstitial; Answer mode repeats it for links
	 * that never pass through the reader.
	 *
	 * The destination it names is the From address, because that is what a reply is
	 * actually addressed to here (`buildReplySpec` prefills `To: [fromAddress]`) —
	 * naming the Reply-To instead would describe a send this client does not make.
	 */
	function runGuarded(msg: PostboxReaderMessage | undefined, action: () => void) {
		if (!msg) {
			action();
			return;
		}
		const threadId = msg.threadId ?? msg._id;
		source.guardEl.value?.guard(
			threadId,
			replyRisk(msg),
			extractEmailAddress(msg.fromAddress),
			action
		);
	}

	/** Guard a reply/reply-all against the LATEST message (the keyboard paths). */
	function guardLatestReply(run: () => void) {
		runGuarded(source.latestMessage.value, run);
	}

	// Reply / reply-all / forward: every one of them opens Answer mode.
	const composer = usePostboxReaderComposer({
		// List rows carry no body (plan 2.3): quote from the thread query's copy of
		// the open message once it has loaded, so Reply/Forward need no body fetch.
		getMessage: () =>
			source.messages.value.find((m) => m._id === source.message()._id) ?? source.message(),
		latestMessage: source.latestMessage,
		ownAddresses: source.ownAddresses,
		replyDefault: source.replyDefault,
		// The keyboard reply paths go through the sender-auth reply guard against
		// the latest message.
		guardReply: (run) => guardLatestReply(run),
	});

	function guardedReply(msg: PostboxReaderMessage) {
		runGuarded(msg, () => composer.openPrimaryReply(msg));
	}

	function guardedReplyAll(msg: PostboxReaderMessage) {
		runGuarded(msg, () => composer.openReplyAll(msg));
	}

	// Files dropped on the conversation reply to it the way `r` does: to the latest
	// message, as the person's default reply, behind the sender-auth reply guard.
	const replyDrop = computed<ReplyDropTarget | null>(() => {
		const latest = source.latestMessage.value;
		if (!latest || source.folderRole() === 'drafts') return null;
		return {
			kind: 'message',
			id: latest._id,
			recipient: replyDropRecipient(latest, source.ownAddresses.value),
			replyKind: primaryReplyKindFor(source.replyDefault.value, latest, source.ownAddresses.value),
			guard: guardLatestReply,
		};
	});

	return { ...composer, runGuarded, guardLatestReply, guardedReply, guardedReplyAll, replyDrop };
}
