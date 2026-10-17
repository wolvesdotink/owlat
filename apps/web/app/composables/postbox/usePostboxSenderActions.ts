import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** A sender, named the way `api.mail.senders.status.*` takes it. */
export type PostboxSenderTarget =
	| { mailboxId: Id<'mailboxes'>; senderDigest: string }
	| { messageId: Id<'mailMessages'> };

/**
 * What a person does to a sender (SPEC §5), shared by the Senders page and
 * the reader's ⇧E / ⇧U: set the status, unsubscribe, resume paused drafts.
 * Each server call is one undoable operation; the toast says what happened,
 * including the recent mail it archived.
 *
 * Unsubscribe always asks first: it changes what happens to future mail and,
 * for one-click senders, sends a request to a third party. A one-click host
 * the caller knows (the open message's header) gets the chip's own wording.
 */
export function usePostboxSenderActions() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { openManualUnsubscribe } = usePostboxUnsubscribeOpen();

	const setStatusOp = useBackendOperation(api.mail.senders.status.setStatus, {
		label: () => t('postbox.senders.operations.setStatus'),
	});
	const unsubscribeOp = useBackendOperation(api.mail.senders.status.unsubscribe, {
		label: () => t('postbox.senders.operations.unsubscribe'),
	});
	const resumeOp = useBackendOperation(api.mail.senders.status.resumeDrafts, {
		label: () => t('postbox.senders.operations.resumeDrafts'),
	});

	function archivedToast(name: string, archived: number, fallbackKey: string) {
		if (archived > 0) {
			showToast(t('postbox.senders.toast.archived', { count: archived, name }, archived));
		} else {
			showToast(t(fallbackKey, { name }));
		}
	}

	async function setStatus(
		target: PostboxSenderTarget,
		status: 'keep' | 'digest' | 'auto_archive',
		name?: string
	): Promise<boolean> {
		const result = await setStatusOp.run({ target, status });
		if (!result.ok) return false;
		archivedToast(
			name ?? result.result.address,
			result.result.archived,
			`postbox.senders.toast.status.${status}`
		);
		return true;
	}

	async function unsubscribe(
		target: PostboxSenderTarget,
		opts: { mailboxId: string; name?: string; oneClickHost?: string | null }
	): Promise<boolean> {
		const confirmText = opts.oneClickHost
			? t('components.postbox.postboxUnsubscribeChip.confirm', { host: opts.oneClickHost })
			: t('postbox.senders.confirmUnsubscribe', { name: opts.name ?? '' });
		if (!window.confirm(confirmText)) return false;
		const result = await unsubscribeOp.run({ target });
		if (!result.ok) return false;
		const { method, archived, address, httpUrl, mailtoUrl } = result.result;
		const name = opts.name ?? address;
		if (method === 'mailto' || method === 'https') {
			openManualUnsubscribe({ httpUrl, mailtoUrl }, opts.mailboxId);
			showToast(t('postbox.senders.result.opened'));
			return true;
		}
		archivedToast(
			name,
			archived,
			method === 'one_click'
				? 'postbox.senders.toast.unsubscribing'
				: 'postbox.senders.toast.localOnly'
		);
		return true;
	}

	async function resumeDrafts(target: PostboxSenderTarget): Promise<boolean> {
		const result = await resumeOp.run({ target });
		if (result.ok) showToast(t('postbox.senders.toast.draftsResumed'));
		return result.ok;
	}

	const isBusy = computed(
		() => setStatusOp.isLoading.value || unsubscribeOp.isLoading.value || resumeOp.isLoading.value
	);

	return { setStatus, unsubscribe, resumeDrafts, isBusy };
}
