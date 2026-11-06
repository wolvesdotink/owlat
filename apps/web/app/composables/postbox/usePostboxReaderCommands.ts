/**
 * The verbs PostboxThreadReader offers beyond its buttons: Translate, Copy link,
 * Share in chat and Share as image, Find in conversation (⌘F), moving the open
 * message to another mailbox, the chat layout, copying the conversation's
 * sign-in code, the ⌘K surface with every verb the reader has, and the
 * single-key reading shortcuts. All of them act on THIS
 * conversation, and only the reader on top answers the shortcuts.
 */
import { computed, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { ConversationLinkTarget } from '~/utils/conversationLink';
import { extractEmailAddress } from '~/utils/emailAddress';
import { useConversationLink } from '~/composables/useConversationLink';
import { useSenderZoom } from '~/composables/useSenderZoom';
import { postboxSenderKey } from '~/utils/postboxImageAllowlist';
import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { PostboxReaderMessage, PostboxReaderThread } from './postboxReaderMessage';
import type { usePostboxReaderActions } from './usePostboxReaderActions';
import type { usePostboxThreadPages } from './usePostboxThreadPages';
import { usePostboxThreadFind, type PostboxFindSeed } from './usePostboxThreadFind';
import type { PostboxTransferMode } from './usePostboxMailboxTransfer';
import type { usePostboxReaderAttachments } from './usePostboxReaderAttachments';
import { usePostboxThreadChat } from './usePostboxThreadChat';
import {
	latestLiveSignInCode,
	usePostboxSignInCode,
	usePostboxSignInCodeIntent,
} from './usePostboxSignInCode';

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
	attachments: ReturnType<typeof usePostboxReaderAttachments>;
	/** The mailbox is a team inbox (no chat layout). */
	isShared: () => boolean;
	/** The brief marks a quote in this message or keeps its exact wording: its card must show. */
	mustShowCard: (messageId: string) => boolean;
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

	// "Share as image…", from a card's ⋯ menu (that card's message) or the palette
	// (the open message). Mail whose raw body the reader does not show as text,
	// sealed or signed, is not offered: the card would draw the raw body. The
	// dialog follows the live row by id, so a body still on its way when it
	// opened reaches it.
	const shareImageId = shallowRef<string | null>(null);
	const rowOf = (id: string) =>
		source.messages.value.find((msg) => msg._id === id) ??
		(source.message()._id === id ? source.message() : null);
	const shareImageMessage = computed<PostboxReaderMessage | null>({
		get: () => (shareImageId.value ? rowOf(shareImageId.value) : null),
		set: (msg) => (shareImageId.value = msg?._id ?? null),
	});
	const canShareAsImage = (msg: PostboxReaderMessage) =>
		source.secureClass(msg) === 'none' && !msg.inboundSignatureInfo;
	const openMessage = () => rowOf(source.message()._id) ?? source.message();

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

	// "Other mailboxes" (the move picker and ⌘K): the open message, like the folder
	// move beside it. A move leaves the conversation, so the reader moves on.
	const transfer = usePostboxMailboxTransfer(() => source.message().mailboxId);
	async function transferOpenMessage(targetId: Id<'mailboxes'>, mode: PostboxTransferMode) {
		actions.moveDialogOpen.value = false;
		if (!(await transfer.confirmTarget(targetId))) return;
		const run = (id: Id<'mailMessages'>) => transfer.transfer([id], targetId, mode);
		if (mode === 'copy') await run(source.message()._id as Id<'mailMessages'>);
		else
			await actions.runAndAdvance(async (id) =>
				(await run(id)) ? { ok: true, result: null } : { ok: false }
			);
	}
	const moves = {
		targets: transfer.targets,
		pick: (targetId: Id<'mailboxes'>, mode: PostboxTransferMode) =>
			void transferOpenMessage(targetId, mode),
	};

	// The chat layout. A find match or a cited quote is marked in the card, and
	// exact wording must not lose its quote or footer, so those show as cards.
	const chat = usePostboxThreadChat({
		threadId: () => source.readerThread.value?._id ?? source.message().threadId,
		isShared: source.isShared,
		ownAddresses: source.ownAddresses,
		expanded: source.expanded,
		toggleExpanded: source.toggleExpanded,
		isPlain: (msg) =>
			source.secureClass(msg) === 'none' && !msg.inboundSignatureInfo && !source.hideRawBody(msg),
		needsCard: (messageId) =>
			source.mustShowCard(messageId) || (find.hasQuery.value && find.matchCountOf(messageId) > 0),
		previewAttachment: source.attachments.openAttachmentPreview,
		downloadAttachment: (messageId, att) =>
			void source.attachments.handleAttachmentDownload(messageId, att),
	});
	// "Copy sign-in code": the newest live code in the conversation, with the
	// chip's own copy (or open, for a link).
	const signInCode = usePostboxSignInCode();
	const copySignInCode = () =>
		void signInCode.copyOrOpen(
			latestLiveSignInCode(source.messages.value) ?? source.message().signInCode
		);

	// These shortcuts' actions live here, not among the triage actions.
	const runAction = (action: string) => {
		if (action === 'chatView') void chat.toggle();
		else if (action === 'copySignInCode') copySignInCode();
		else actions.runReaderAction(action);
	};

	// ⌘K, while a conversation is open, offers every verb this reader has. Runs the
	// actions directly, so it acts on THIS conversation.
	const senderZoom = useSenderZoom();
	const threadSurface = usePostboxThreadCommandSurface({
		subject: () => source.message().subject,
		messageId: () => source.message()._id,
		threadId: () => source.readerThread.value?._id ?? source.message().threadId,
		mailboxId: () => source.message().mailboxId,
		href: () => `/dashboard/postbox/${source.folderRole() ?? 'inbox'}/${source.message()._id}`,
		link: () => conversationLinkOf(source.message()._id),
		shareInChat: () => (shareTarget.value = conversationLinkOf(source.message()._id)),
		canShareAsImage: () => canShareAsImage(openMessage()),
		shareAsImage: () => (shareImageMessage.value = openMessage()),
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
		runAction,
		snooze: (until) => actions.snoozeOpenMessage(until, 'thread'),
		snoozeUntilReply: actions.snoozeOpenMessageUntilReply,
		applyLabel: (labelId) => void actions.applyLabelToOpenMessage(labelId),
		moveTo: (folderId) => void actions.moveOpenMessageTo(folderId),
		mailboxes: () => moves.targets.value,
		transferTo: moves.pick,
		toggleMute: actions.toggleOpenThreadMute,
		toggleAlert: actions.toggleOpenThreadAlert,
		togglePin: actions.toggleOpenThreadPin,
		translate: () => void translation.translate(),
		find: () => find.open(),
		senderZoom: () => {
			const from = source.message().fromAddress;
			return postboxSenderKey(from) ? senderZoom.zoomOf(from) : null;
		},
		chatView: () =>
			chat.isAvailable.value
				? { isOn: () => chat.isOn.value, toggle: () => void chat.toggle() }
				: null,
	});

	// A web push's "Copy code" button lands here with the copy request.
	usePostboxSignInCodeIntent({
		messageId: () => source.message()._id,
		isTopmost: () => threadSurface.isTopmost(),
		run: copySignInCode,
	});

	// Single-key shortcuts while reading and the Cmd-K palette bridge, both
	// dispatching into runReaderAction (see utils/postboxShortcuts.ts).
	usePostboxReaderShortcuts({
		runAction,
		applyLabel: (labelId) => {
			void actions.applyLabelToOpenMessage(labelId);
		},
	});

	return {
		translation,
		find,
		chat,
		shareTarget,
		shareImageMessage,
		copyConversationLink,
		conversationLinkOf,
		moves,
	};
}
