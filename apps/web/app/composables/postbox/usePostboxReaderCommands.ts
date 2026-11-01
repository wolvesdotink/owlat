/**
 * The verbs PostboxThreadReader offers beyond its buttons: Translate, Copy link
 * and Share in chat, Find in conversation (⌘F), the ⌘K surface with every verb
 * the reader has, and the single-key reading shortcuts. All of them act on
 * THIS conversation, and only the reader on top answers the shortcuts.
 */
import { computed, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { ConversationLinkTarget } from '~/utils/conversationLink';
import { extractEmailAddress } from '~/utils/emailAddress';
import { useConversationLink } from '~/composables/useConversationLink';
import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { PostboxReaderMessage, PostboxReaderThread } from './postboxReaderMessage';
import type { usePostboxReaderActions } from './usePostboxReaderActions';
import type { usePostboxThreadPages } from './usePostboxThreadPages';
import { usePostboxThreadFind, type PostboxFindSeed } from './usePostboxThreadFind';

export function usePostboxReaderCommands(source: {
	message: () => PostboxReaderMessage;
	folderRole: () => string | undefined;
	findSeed: () => PostboxFindSeed | null | undefined;
	threadKey: () => string;
	pages: ReturnType<typeof usePostboxThreadPages>;
	messages: ComputedRef<PostboxReaderMessage[]>;
	latestMessage: ComputedRef<PostboxReaderMessage | undefined>;
	ownAddresses: Ref<Set<string>>;
	readerThread: Ref<PostboxReaderThread | null | undefined>;
	latestOutboundId: Ref<string | undefined>;
	expanded: Ref<Set<string>>;
	toggleExpanded: (messageId: string) => void;
	secureClass: (msg: { _id: string }) => SecureMessageClass;
	hideRawBody: (msg: { _id: string }) => boolean;
	aiEnabled: () => boolean;
	actions: ReturnType<typeof usePostboxReaderActions>;
}) {
	const { actions } = source;

	// "Translate" (⌘K): the newest message someone else wrote (your own reply needs
	// no translating), in the app's language, above the thread.
	const translationTarget = computed(
		() =>
			[...source.messages.value]
				.reverse()
				.find((msg) => !source.ownAddresses.value.has(extractEmailAddress(msg.fromAddress))) ??
			source.latestMessage.value
	);
	const translation = usePostboxReaderTranslation(() => translationTarget.value);

	// "Copy link" / "Share in chat…", from any card's ⋯ menu or the palette. The
	// link names the card's message, so it opens the thread at the mail it came from,
	// and the dialog is this reader's own: a second mounted reader never opens it.
	const { copyConversationLink } = useConversationLink();
	function conversationLinkOf(messageId: string): ConversationLinkTarget {
		return {
			kind: 'postbox',
			messageId,
			mailboxId: source.message().mailboxId,
			folder: source.folderRole(),
		};
	}
	const shareTarget = shallowRef<ConversationLinkTarget | null>(null);

	// Find in conversation (⌘F): collapsed messages, folded quotes and envelopes
	// included. Only the reader on top answers the shortcut.
	const find = usePostboxThreadFind({
		threadKey: source.threadKey,
		messages: () => source.messages.value,
		// Encrypted, clearsigned and signed mail shows through its security badge;
		// its raw body is not what the reader shows, so it is not searched.
		searchable: (msg) =>
			source.secureClass(msg) === 'none' && !(msg as PostboxReaderMessage).inboundSignatureInfo,
		isExpanded: (id) => source.expanded.value.has(id),
		expand: source.toggleExpanded,
		pages: source.pages,
		seed: source.findSeed,
		answersShortcut: () => threadSurface.isTopmost(),
	});

	// ⌘K, while a conversation is open, offers every verb this reader has. Runs the
	// actions directly, so it acts on THIS conversation.
	const threadSurface = usePostboxThreadCommandSurface({
		subject: () => source.message().subject,
		messageId: () => source.message()._id,
		threadId: () => source.readerThread.value?._id ?? source.message().threadId,
		mailboxId: () => source.message().mailboxId,
		href: () => `/dashboard/postbox/${source.folderRole() ?? 'inbox'}/${source.message()._id}`,
		link: () => conversationLinkOf(source.message()._id),
		shareInChat: () => (shareTarget.value = conversationLinkOf(source.message()._id)),
		hintText: () => actions.snoozeHintText.value,
		isMuted: () => source.readerThread.value?.mutedAt != null,
		isAlerted: () => source.readerThread.value?.notifyOnReplyAt != null,
		isPinned: () => actions.isThreadPinned.value,
		followUp: () => {
			if (source.readerThread.value?.followUp) return { state: 'armed' };
			const outboundId = source.latestOutboundId.value;
			return outboundId ? { state: 'armable', outboundId } : { state: 'none' };
		},
		canTranslate: () =>
			source.aiEnabled() &&
			!!translationTarget.value &&
			!source.hideRawBody(translationTarget.value),
		labels: () => actions.labels.value,
		folders: () => actions.movableFolders.value,
		runAction: actions.runReaderAction,
		snooze: (until) => actions.snoozeOpenMessage(until, 'thread'),
		snoozeUntilReply: actions.snoozeOpenMessageUntilReply,
		applyLabel: (labelId) => void actions.applyLabelToOpenMessage(labelId),
		moveTo: (folderId) => void actions.moveOpenMessageTo(folderId),
		toggleMute: actions.toggleOpenThreadMute,
		toggleAlert: actions.toggleOpenThreadAlert,
		togglePin: actions.toggleOpenThreadPin,
		translate: () => void translation.translate(),
		find: () => find.open(),
	});

	// Single-key shortcuts while reading and the Cmd-K palette bridge, both
	// dispatching into runReaderAction (see utils/postboxShortcuts.ts).
	usePostboxReaderShortcuts({
		runAction: actions.runReaderAction,
		applyLabel: (labelId) => {
			void actions.applyLabelToOpenMessage(labelId);
		},
	});

	return { translation, find, shareTarget, copyConversationLink, conversationLinkOf };
}
