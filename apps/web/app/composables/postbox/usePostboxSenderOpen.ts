import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Tell the server a message's body was shown (SPEC §5): its sender's "you
 * read" counter counts the first open of live mail. Called by every reader
 * message card, so an older message expanded by hand, a citation that opens
 * one, or a reply that arrives while the thread is open each count when their
 * body is on screen, and a collapsed header never does. Once per message per
 * mount (the server dedupes too), whatever the mark-read policy, and silent:
 * a failed count is not the reader's problem. Bulk and collapsed mark-read
 * never go through here.
 */
export function usePostboxSenderOpen(messageId: () => string, isShown: () => boolean) {
	const { t } = useI18n();
	const markOpenedOp = useBackendOperation(api.mail.senders.opens.markOpened, {
		label: () => t('postbox.senders.operations.markOpened'),
		announce: false,
		onError: () => true,
	});
	const counted = new Set<string>();
	watch(
		() => [messageId(), isShown()] as const,
		([id, shown]) => {
			if (!shown || !id || counted.has(id)) return;
			counted.add(id);
			void markOpenedOp.run({ messageId: id as Id<'mailMessages'> });
		},
		{ immediate: true }
	);
}
