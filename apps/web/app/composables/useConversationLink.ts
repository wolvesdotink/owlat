import { getActiveWorkspace, isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import {
	type ConversationLinkTarget,
	conversationLinkOrigin,
	conversationLinkPath,
} from '~/utils/conversationLink';

/**
 * The origin links to this instance point at, read now (see
 * `conversationLinkOrigin`). The desktop workspace is fixed for a page load.
 */
export function currentConversationLinkOrigin(): string | null {
	if (import.meta.server) return null;
	return conversationLinkOrigin({
		desktop: isDesktopRuntime(),
		workspaceSiteUrl: getActiveWorkspace()?.siteUrl ?? null,
		locationOrigin: window.location.origin,
	});
}

/** The absolute URL of a conversation, or `null` when there is no web origin to use. */
export function conversationLinkUrl(target: ConversationLinkTarget): string | null {
	const origin = currentConversationLinkOrigin();
	return origin ? `${origin}${conversationLinkPath(target)}` : null;
}

/**
 * "Copy link" for a conversation: the one place every surface (the reader's
 * ⋯ menu, the Team Inbox header, the palette) copies from, with the same toast
 * for the outcome. Resolves whether the link reached the clipboard.
 */
export function useConversationLink() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { copy } = useCopyToClipboard();

	async function copyConversationLink(target: ConversationLinkTarget): Promise<boolean> {
		const url = conversationLinkUrl(target);
		if (!url) {
			showToast(t('shared.conversationLink.linkUnavailable'), 'error');
			return false;
		}
		const copied = await copy(url);
		if (copied) showToast(t('shared.conversationLink.linkCopied'));
		else showToast(t('shared.conversationLink.linkCopyFailed'), 'error');
		return copied;
	}

	return { copyConversationLink };
}
