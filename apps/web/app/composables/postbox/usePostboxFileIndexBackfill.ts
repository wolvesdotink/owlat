/**
 * The attachment index's one-shot walk over mail that predates it.
 *
 * Read as a live subscription so the Files view's progress strip updates as the
 * batched job advances, and started through the usual backend-operation wrapper
 * so a refusal (a shared-inbox member, who is not the mailbox owner) surfaces
 * as a toast rather than a silent no-op.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxFileIndexBackfill(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data } = useConvexQuery(api.mail.attachmentBackfill.status, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const status = computed(() => data.value ?? null);

	const startOp = useBackendOperation(api.mail.attachmentBackfill.start, {
		label: () => t('shared.postbox.usePostboxFileIndexBackfill.startIndex'),
	});
	const cancelOp = useBackendOperation(api.mail.attachmentBackfill.cancel, {
		label: () => t('shared.postbox.usePostboxFileIndexBackfill.cancelIndex'),
	});

	async function start() {
		if (!mailboxId.value) return;
		await startOp.run({ mailboxId: mailboxId.value });
	}

	async function cancel() {
		if (!mailboxId.value) return;
		await cancelOp.run({ mailboxId: mailboxId.value });
	}

	return { status, start, cancel, isStarting: startOp.isLoading };
}
