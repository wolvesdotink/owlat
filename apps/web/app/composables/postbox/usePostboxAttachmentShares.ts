/**
 * The share links this person has handed out from one mailbox (idea 10).
 *
 * A link that can be created from the composer and never taken back is not a
 * share, it is a leak with a countdown. This is the other half: one
 * subscription behind the settings card, with revoke and scope-narrowing on
 * every row, so the decision made in a hurry inside a draft stays reversible.
 *
 * The server decides what a row IS (live / revoked / expired, and whether it
 * still has a resolvable URL); nothing here re-derives that, so the card can
 * never offer a copy button for a link the route would refuse.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AttachmentShareScope } from '@owlat/shared/attachmentShares';

export function usePostboxAttachmentShares(mailboxId: Ref<Id<'mailboxes'> | null | undefined>) {
	const { t } = useI18n();

	const { data, isLoading } = useConvexQuery(api.mail.attachmentShares.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const shares = computed(() => data.value ?? []);

	/** Links that still resolve — what the card leads with. */
	const liveShares = computed(() => shares.value.filter((s) => s.state === 'live'));

	const revokeOp = useBackendOperation(api.mail.attachmentShares.revoke, {
		label: () => t('shared.postbox.usePostboxAttachmentShares.revokeOperation'),
	});
	const scopeOp = useBackendOperation(api.mail.attachmentShares.setScope, {
		label: () => t('shared.postbox.usePostboxAttachmentShares.scopeOperation'),
	});

	/** Kill a link and delete the file behind it. */
	async function revoke(shareId: Id<'mailAttachmentShares'>): Promise<boolean> {
		return (await revokeOp.run({ shareId })).ok;
	}

	/**
	 * Narrow a link to the mailbox (the partial revoke: the public URL dies, the
	 * file survives) or widen it back.
	 */
	async function setScope(
		shareId: Id<'mailAttachmentShares'>,
		scope: AttachmentShareScope
	): Promise<boolean> {
		return (await scopeOp.run({ shareId, scope })).ok;
	}

	/**
	 * The owner's own way back to the file, for a link the public route will not
	 * serve (narrowed to the mailbox).
	 *
	 * A one-shot query rather than a subscription: the server mints a short-lived
	 * storage URL, and holding one open in the list would mean every row on the
	 * card carrying a live download URL for as long as the page is open — the
	 * exact thing "limit to my mailbox" was pressed to stop.
	 */
	async function openOwnCopy(shareId: Id<'mailAttachmentShares'>): Promise<boolean> {
		const url = await requireConvex().query(api.mail.attachmentShares.downloadUrl, { shareId });
		if (!url) return false;
		window.open(url, '_blank', 'noopener,noreferrer');
		return true;
	}

	return {
		shares,
		liveShares,
		isLoading,
		revoke,
		setScope,
		openOwnCopy,
		isSaving: computed(() => revokeOp.isLoading.value || scopeOp.isLoading.value),
	};
}
