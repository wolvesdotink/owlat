/**
 * Per-mailbox "always show images from this sender" list.
 *
 * One subscription per mailbox, shared by the reader (which asks "is THIS
 * sender trusted?" once per rendered message) and the settings screen (which
 * renders the whole list with a revoke on each row). Keeping it in one place
 * means the reader's banner flips the moment a grant is revoked in settings,
 * with no refetch and no cache to invalidate.
 *
 * The grant is remote images only — tracking-pixel stripping is unaffected by
 * anything here (see `utils/postboxImageAllowlist`).
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isPostboxSenderImageAllowed, postboxSenderKey } from '~/utils/postboxImageAllowlist';

export function usePostboxImageAllowlist(mailboxId: Ref<Id<'mailboxes'> | null | undefined>) {
	const { t } = useI18n();

	const { data, isLoading } = useConvexQuery(api.mail.imageAllowlist.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const entries = computed(() => data.value ?? []);

	const allowOp = useBackendOperation(api.mail.imageAllowlist.allow, {
		label: () => t('shared.postbox.usePostboxImageAllowlist.allowOperation'),
	});
	const revokeOp = useBackendOperation(api.mail.imageAllowlist.revoke, {
		label: () => t('shared.postbox.usePostboxImageAllowlist.revokeOperation'),
	});

	/** Is this From header's sender allowed to load remote images? */
	function isAllowed(fromAddress: string | undefined | null): boolean {
		return isPostboxSenderImageAllowed(entries.value, fromAddress);
	}

	/** Trust a sender. No-op when the From header holds no usable address. */
	async function allow(fromAddress: string | undefined | null): Promise<boolean> {
		const senderEmail = postboxSenderKey(fromAddress);
		if (!senderEmail || !mailboxId.value) return false;
		return (await allowOp.run({ mailboxId: mailboxId.value, senderEmail })).ok;
	}

	/** Revoke a grant, by From header or by the stored canonical address. */
	async function revoke(fromAddress: string | undefined | null): Promise<boolean> {
		const senderEmail = postboxSenderKey(fromAddress);
		if (!senderEmail || !mailboxId.value) return false;
		return (await revokeOp.run({ mailboxId: mailboxId.value, senderEmail })).ok;
	}

	return {
		entries,
		isLoading,
		isAllowed,
		allow,
		revoke,
		isSaving: computed(() => allowOp.isLoading.value || revokeOp.isLoading.value),
	};
}
