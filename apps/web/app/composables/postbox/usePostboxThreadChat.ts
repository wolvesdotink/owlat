/**
 * The chat layout of a personal thread: one bubble per message, the viewer's
 * own on the right and everyone else's on the left, with the quoted history
 * and signature cut away (PostboxChatBubble). It reads best for short
 * back-and-forth between two or three people.
 *
 * The choice is per person and per thread, stored with the thread's viewer
 * state (`mail/threadView.ts`), so it follows the person to another device.
 * "Show full message" swaps one bubble for the ordinary card and "Back to
 * chat" swaps it back; that part is local to this reader.
 *
 * A team inbox has no chat layout: its reader interleaves the team stream
 * between the messages, and the backend refuses the choice there.
 */
import { computed, ref, shallowReactive, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ThreadView } from '@owlat/shared/threadBrief';
import { extractEmailAddress } from '~/utils/emailAddress';
import type { AttachmentMeta } from '~/utils/attachmentMeta';
import type { PostboxReaderMessage } from './postboxReaderMessage';

export interface PostboxThreadChatSource {
	/** The open thread, once known. */
	threadId: () => string | undefined;
	/** The mailbox is a team inbox. */
	isShared: () => boolean;
	ownAddresses: Ref<Set<string>>;
	expanded: Ref<Set<string>>;
	toggleExpanded: (messageId: string) => void;
	/**
	 * Ordinary mail. Signed or encrypted content shows only through the card's
	 * security badge, so it never becomes a bubble.
	 */
	isPlain: (msg: PostboxReaderMessage) => boolean;
	/**
	 * The card must show (a find match or a cited quote is marked in it, or
	 * the brief keeps its exact wording), so the bubble stands aside.
	 */
	needsCard: (messageId: string) => boolean;
	previewAttachment: (messageId: string, att: AttachmentMeta, all: AttachmentMeta[]) => void;
	downloadAttachment: (messageId: string, att: AttachmentMeta) => void;
}

export function usePostboxThreadChat(source: PostboxThreadChatSource) {
	const { t } = useI18n();
	const threadId = computed(() => (source.isShared() ? undefined : source.threadId()));
	const { data: stored } = useConvexQuery(api.mail.threadView.get, () =>
		threadId.value ? { threadId: threadId.value as Id<'mailThreads'> } : ('skip' as const)
	);
	const setOp = useBackendOperation(api.mail.threadView.set, {
		label: () => t('components.postbox.threadChat.operation'),
	});

	// The choice shows at once; the stored one takes over when the write lands
	// (or the old one comes back if it fails).
	const pending = ref<{ threadId: string; view: ThreadView } | null>(null);
	const view = computed<ThreadView | null>(() => {
		const id = threadId.value;
		if (!id) return null;
		if (pending.value?.threadId === id) return pending.value.view;
		return (stored.value as ThreadView | null | undefined) ?? null;
	});

	const isAvailable = computed(() => !!threadId.value);
	const isOn = computed(() => view.value === 'chat');

	// Messages shown as their full card while the chat layout is on, by
	// request ("Show full message") or because they turned out to be secure.
	const full = shallowReactive(new Set<string>());
	const secure = shallowReactive(new Set<string>());

	async function toggle() {
		const id = threadId.value;
		if (!id) return;
		const next: ThreadView = isOn.value ? 'conversation' : 'chat';
		full.clear();
		pending.value = { threadId: id, view: next };
		try {
			await setOp.run({ threadId: id as Id<'mailThreads'>, view: next });
		} finally {
			if (pending.value?.threadId === id && pending.value.view === next) pending.value = null;
		}
	}

	function isBubble(msg: PostboxReaderMessage): boolean {
		if (!isOn.value || full.has(msg._id) || secure.has(msg._id)) return false;
		return source.isPlain(msg) && !source.needsCard(msg._id);
	}

	/** The card stands in with a way back to the bubble. */
	function isShownFull(messageId: string): boolean {
		return isOn.value && full.has(messageId) && !secure.has(messageId);
	}

	function showFull(messageId: string) {
		full.add(messageId);
		if (!source.expanded.value.has(messageId)) source.toggleExpanded(messageId);
	}

	function showBubble(messageId: string) {
		full.delete(messageId);
	}

	function keepCard(messageId: string) {
		secure.add(messageId);
	}

	function isOwn(msg: { fromAddress: string }): boolean {
		return source.ownAddresses.value.has(extractEmailAddress(msg.fromAddress));
	}

	return {
		isAvailable,
		isOn,
		isSaving: setOp.isLoading,
		toggle,
		isBubble,
		isShownFull,
		showFull,
		showBubble,
		keepCard,
		isOwn,
		previewAttachment: source.previewAttachment,
		downloadAttachment: source.downloadAttachment,
	};
}

export type PostboxThreadChat = ReturnType<typeof usePostboxThreadChat>;
