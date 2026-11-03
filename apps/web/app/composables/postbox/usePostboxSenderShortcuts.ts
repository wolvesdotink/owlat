import type { ComputedRef } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { useSenderZoom } from '~/composables/useSenderZoom';

/** What the sender chords read off the open message. */
export interface SenderShortcutMessage {
	_id: string;
	fromAddress?: string;
	fromName?: string;
	unsubscribe?: { oneClick?: boolean; httpUrl?: string };
}

function hostOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/**
 * ⇧E / ⇧O from the open message: Auto-archive its sender, or
 * unsubscribe from it. A one-click sender gets the Unsubscribe chip's own
 * confirm, naming the host the request goes to. `+` / `-` / `0` step the
 * sender's zoom.
 */
export function usePostboxSenderShortcuts(mailboxId: ComputedRef<Id<'mailboxes'>>) {
	const actions = usePostboxSenderActions();
	const { applyZoom } = useSenderZoom();

	/** Runs a sender chord; false when `action` is not one. */
	function runSenderShortcut(action: string, message: SenderShortcutMessage): boolean {
		const target = { messageId: message._id as Id<'mailMessages'> };
		const name = message.fromName || message.fromAddress;
		if (action === 'senderAutoArchive') {
			void actions.setStatus(target, 'auto_archive', name);
			return true;
		}
		if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
			return applyZoom(message.fromAddress, action);
		}
		if (action === 'senderUnsubscribe') {
			const oneClick = message.unsubscribe?.oneClick ? hostOf(message.unsubscribe.httpUrl) : null;
			void actions.unsubscribe(target, {
				mailboxId: mailboxId.value,
				name,
				oneClickHost: oneClick,
			});
			return true;
		}
		return false;
	}

	return { runSenderShortcut };
}
