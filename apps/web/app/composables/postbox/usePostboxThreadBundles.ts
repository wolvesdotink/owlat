/**
 * The bundled inbox feed: the flat list's own rows, folded by
 * `utils/postboxBundles`, plus the two verbs a bundle offers.
 *
 * The fold needs a category per row, and the advisory smart-inbox category
 * lives on the THREAD, not the message — so this reuses the same
 * `listThreads` feed the Categories view already subscribes to (the Convex
 * client dedupes the subscription) and indexes it by thread id. Exactly the
 * join PostboxTodayView does, for the same reason.
 *
 * The verbs act on a bundle's ids DIRECTLY rather than through the shared
 * bulk-selection bucket: "archive these twelve" is one gesture on one row, and
 * routing it through the selection would silently discard whatever the user
 * had ticked.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxBundleMessage } from '~/utils/postboxBundles';
import { bundlePostboxFeed } from '~/utils/postboxBundles';

export function usePostboxThreadBundles<T extends PostboxBundleMessage>(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	messages: Ref<T[]>;
	enabled: Ref<boolean>;
}) {
	const { t } = useI18n();

	const { data: threadData } = useConvexQuery(api.mail.mailbox.queries.listThreads, () =>
		args.enabled.value && args.mailboxId.value
			? { mailboxId: args.mailboxId.value, folderRole: 'inbox' }
			: 'skip'
	);
	const categoryByThread = computed(() => {
		const map = new Map<string, string>();
		for (const thread of threadData.value?.threads ?? []) {
			if (thread.category?.label) map.set(thread._id, thread.category.label);
		}
		return map;
	});

	const entries = computed(() =>
		bundlePostboxFeed(args.messages.value, {
			categoryOf: (message) =>
				message.threadId ? categoryByThread.value.get(message.threadId) : undefined,
		})
	);

	// Which bundles the user has opened, remembered across navigations for the
	// session (the same shape the category sections use). Collapsed is the
	// default: a bundle that opens itself is just the flat list again.
	const expanded = useState<Record<string, boolean>>('postbox:bundle-expanded', () => ({}));
	function toggle(bundleId: string) {
		expanded.value = { ...expanded.value, [bundleId]: !expanded.value[bundleId] };
	}

	const triageUndo = usePostboxTriageUndo();
	const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
		label: () => t('shared.postbox.usePostboxThreadBundles.archiveOperation'),
	});
	const moveOp = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('shared.postbox.usePostboxThreadBundles.moveOperation'),
	});
	const unsubscribeOp = useBackendOperation(api.mail.subscriptions.unsubscribeAndArchive, {
		label: () => t('shared.postbox.usePostboxThreadBundles.unsubscribeOperation'),
		type: 'action',
	});

	/**
	 * Archive every message the bundle stands for, in one call, with the house
	 * move-back undo — twelve rows archived by mistake has to be one Cmd+Z, not
	 * twelve.
	 */
	async function archiveBundle(messageIds: string[]): Promise<boolean> {
		if (messageIds.length === 0) return false;
		const result = await archiveOp.run({ messageIds: messageIds as Id<'mailMessages'>[] });
		if (!result.ok) return false;
		if (result.result?.moved) {
			triageUndo.registerMoveBack({
				label: t('shared.postbox.usePostboxThreadBundles.undoArchived', {
					count: result.result.moved.length,
				}),
				moved: result.result.moved,
				runMove: (moveArgs) => moveOp.run(moveArgs),
			});
		}
		return true;
	}

	/**
	 * Unsubscribe from every one-click sender in the bundle and archive what
	 * they still have in the Inbox — the existing batch verb, reached from the
	 * row where the twelve newsletters actually are.
	 *
	 * State-changing requests to third parties, times N: never fired without an
	 * explicit yes, exactly like the Subscriptions panel.
	 */
	async function unsubscribeBundle(senderEmails: string[], messageIds: string[]): Promise<boolean> {
		const mailboxId = args.mailboxId.value;
		if (!mailboxId || senderEmails.length === 0) return false;
		const confirmed = window.confirm(
			t('shared.postbox.usePostboxThreadBundles.unsubscribeConfirm', {
				count: senderEmails.length,
			})
		);
		if (!confirmed) return false;
		const result = await unsubscribeOp.run({
			mailboxId,
			senderEmails,
			messageIds: messageIds as Id<'mailMessages'>[],
		});
		return result.ok;
	}

	const isBusy = computed(() => archiveOp.isLoading.value || unsubscribeOp.isLoading.value);

	return { entries, expanded, toggle, archiveBundle, unsubscribeBundle, isBusy };
}
