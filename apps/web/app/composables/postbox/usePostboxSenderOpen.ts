import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Tell the server the reader showed a message open (SPEC §5): its sender's
 * "you read" counter counts the first open of live mail. Once per message per
 * mount, whatever the mark-read policy, and silent: a failed count is not the
 * reader's problem. Bulk mark-read never goes through here.
 */
export function usePostboxSenderOpen(messageId: Ref<Id<'mailMessages'>>) {
	const { t } = useI18n();
	const markOpenedOp = useBackendOperation(api.mail.senders.opens.markOpened, {
		label: () => t('postbox.senders.operations.markOpened'),
		announce: false,
		onError: () => true,
	});
	const counted = new Set<string>();
	watch(
		messageId,
		(id) => {
			if (!id || counted.has(id)) return;
			counted.add(id);
			void markOpenedOp.run({ messageId: id });
		},
		{ immediate: true }
	);
}
