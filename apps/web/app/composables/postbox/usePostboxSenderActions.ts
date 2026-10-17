import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { usePostboxArrivalUndo } from '~/composables/postbox/usePostboxArrivalUndo';

/** What one unsubscribe did (local half, request result), as the action returns it. */
export type PostboxUnsubscribeOutcome = FunctionReturnType<
	typeof api.mail.senders.unsubscribeActions.unsubscribe
>;

/** A sender, named the way `api.mail.senders.status.*` takes it. */
export type PostboxSenderTarget =
	| { mailboxId: Id<'mailboxes'>; senderDigest: string }
	| { messageId: Id<'mailMessages'> };

/**
 * What a person does to a sender (SPEC §5), shared by the Senders page, the
 * Subscriptions panel, the reader's Unsubscribe chip and ⇧E / ⇧O: set the
 * status, unsubscribe, resume paused drafts.
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
	const { offerUndo } = usePostboxArrivalUndo();

	const setStatusOp = useBackendOperation(api.mail.senders.status.setStatus, {
		label: () => t('postbox.senders.operations.setStatus'),
	});
	const unsubscribeOp = useBackendOperation(api.mail.senders.unsubscribeActions.unsubscribe, {
		label: () => t('postbox.senders.operations.unsubscribe'),
		type: 'action',
	});
	const resumeOp = useBackendOperation(api.mail.senders.status.resumeDrafts, {
		label: () => t('postbox.senders.operations.resumeDrafts'),
	});

	/** What a sender change did, with Undo for its operation (read on arrival §4.4). */
	function archivedToast(
		name: string,
		archived: number,
		fallbackKey: string,
		operationId: Id<'mailArrivalOperations'> | null
	) {
		offerUndo(
			archived > 0
				? t('postbox.senders.toast.archived', { count: archived, name }, archived)
				: t(fallbackKey, { name }),
			operationId
		);
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
			`postbox.senders.toast.status.${status}`,
			result.result.operationId
		);
		return true;
	}

	/** Open the sender's own page when the one-click request did not go through. */
	function openFallbackPage(outcome: PostboxUnsubscribeOutcome) {
		if (outcome.httpUrl) window.open(outcome.httpUrl, '_blank', 'noopener,noreferrer');
	}

	/**
	 * Unsubscribe through the ONE path (`api.mail.senders.unsubscribeActions`):
	 * personal mail is suppressed locally and the guarded request's result is
	 * recorded; a team-inbox message only gets the request. Null when the
	 * person declined the confirm or the call failed (already toasted).
	 */
	async function unsubscribe(
		target: PostboxSenderTarget,
		opts: { mailboxId: string; name?: string; oneClickHost?: string | null }
	): Promise<PostboxUnsubscribeOutcome | null> {
		const confirmText = opts.oneClickHost
			? t('components.postbox.postboxUnsubscribeChip.confirm', { host: opts.oneClickHost })
			: t('postbox.senders.confirmUnsubscribe', { name: opts.name ?? '' });
		if (!window.confirm(confirmText)) return null;
		const run = await unsubscribeOp.run({ target });
		if (!run.ok) return null;
		const outcome = run.result;
		const name = opts.name ?? outcome.address;
		if (outcome.method === 'mailto' || outcome.method === 'https') {
			openManualUnsubscribe(outcome, opts.mailboxId);
			if (outcome.scope === 'personal') {
				offerUndo(t('postbox.senders.result.opened'), outcome.operationId);
			}
			return outcome;
		}
		if (outcome.result === 'failed') {
			showToast(
				outcome.scope === 'personal'
					? t('postbox.senders.result.failed')
					: t('components.postbox.postboxUnsubscribeChip.requestFailed'),
				'error'
			);
			openFallbackPage(outcome);
			return outcome;
		}
		if (outcome.scope === 'shared') {
			if (outcome.result === 'confirmed') {
				showToast(t('components.postbox.postboxUnsubscribeChip.requestSent'));
			}
			return outcome;
		}
		archivedToast(
			name,
			outcome.archived,
			outcome.result === 'confirmed'
				? 'postbox.senders.toast.unsubscribed'
				: 'postbox.senders.toast.localOnly',
			outcome.operationId
		);
		return outcome;
	}

	async function resumeDrafts(target: PostboxSenderTarget): Promise<boolean> {
		const result = await resumeOp.run({ target });
		if (result.ok) offerUndo(t('postbox.senders.toast.draftsResumed'), result.result.operationId);
		return result.ok;
	}

	const isBusy = computed(
		() => setStatusOp.isLoading.value || unsubscribeOp.isLoading.value || resumeOp.isLoading.value
	);

	return { setStatus, unsubscribe, resumeDrafts, isBusy };
}
