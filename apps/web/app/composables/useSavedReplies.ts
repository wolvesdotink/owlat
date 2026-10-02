/**
 * Saved replies, as the web app reads and writes them (`mail/savedReplies.ts`).
 *
 *  - {@link useComposerSavedReplies}: what one composer may insert, in the
 *    shape the editors take, plus counting a use.
 *  - {@link useCreateSavedReply}: "save this text as a reply".
 *  - {@link useSavedReplyLibrary}: one scope's list with create / update /
 *    remove, for Preferences (personal) and the admin page (shared).
 *
 * Saved replies exist wherever a composer does: the Postbox (`postbox`,
 * `mail.external`) or the Team inbox (`inbox`); the reads skip otherwise.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';
import type { SnippetVariable } from '~/utils/postboxSnippetVariables';

export type SavedReplyScope = 'personal' | 'shared';

/** What a new reply is made of. `mailboxIds` only means something when shared. */
export interface SavedReplyDraft {
	name: string;
	shortcut: string;
	bodyHtml: string;
	variables?: SnippetVariable[];
	mailboxIds?: Id<'mailboxes'>[];
}

function useSavedRepliesAvailable() {
	const { isEnabled } = useFeatureFlag();
	return computed(() => isEnabled('postbox') || isEnabled('mail.external') || isEnabled('inbox'));
}

/** Create a reply in `scope`; shared needs an admin (the server checks). */
export function useCreateSavedReply() {
	const { t } = useI18n();
	const op = useBackendOperation(api.mail.savedReplies.create, {
		label: () => t('shared.savedReplies.operations.create'),
	});
	return (scope: SavedReplyScope, draft: SavedReplyDraft) => op.run({ scope, ...draft });
}

/**
 * The replies the caller may insert in a composer writing from `mailboxId`
 * (null: a Team inbox reply), most used first.
 */
export function useComposerSavedReplies(mailboxId: () => Id<'mailboxes'> | null) {
	const { t } = useI18n();
	const available = useSavedRepliesAvailable();
	const { data, isLoading } = useConvexQuery(api.mail.savedReplies.listForComposer, () => {
		if (!available.value) return 'skip';
		const id = mailboxId();
		return id ? { mailboxId: id } : {};
	});
	const replies = computed<EditorSnippet[]>(() =>
		(data.value ?? []).map((reply) => ({
			_id: reply._id,
			name: reply.name,
			shortcut: reply.shortcut,
			bodyHtml: reply.bodyHtml,
			variables: (reply.variables ?? undefined) as SnippetVariable[] | undefined,
			isShared: reply.scope === 'shared',
			useCount: reply.useCount,
			lastUsedAt: reply.lastUsedAt,
		}))
	);

	// Bookkeeping for the picker's order: a failure must not get in the way of
	// the reply that already went in, so it is never announced.
	const recordUseOp = useBackendOperation(api.mail.savedReplies.recordUse, {
		label: () => t('shared.savedReplies.operations.recordUse'),
		announce: false,
	});
	function recordUse(replyId: string) {
		void recordUseOp.run({ replyId: replyId as Id<'mailSnippets'> });
	}

	return { replies, isLoading, recordUse };
}

/** One scope's replies with everything the management pages do to them. */
export function useSavedReplyLibrary(scope: SavedReplyScope) {
	const { t } = useI18n();
	const available = useSavedRepliesAvailable();
	const mine = useConvexQuery(api.mail.savedReplies.listMine, () =>
		available.value && scope === 'personal' ? {} : 'skip'
	);
	const shared = useConvexQuery(api.mail.savedReplies.listShared, () =>
		available.value && scope === 'shared' ? {} : 'skip'
	);
	const source = scope === 'personal' ? mine : shared;
	const replies = computed(() =>
		scope === 'personal' ? (mine.data.value ?? []) : (shared.data.value?.replies ?? [])
	);
	/** Personal replies are always the caller's; shared ones need an admin. */
	const canManage = computed(() => scope === 'personal' || shared.data.value?.canManage === true);

	const create = useCreateSavedReply();
	const updateOp = useBackendOperation(api.mail.savedReplies.update, {
		label: () => t('shared.savedReplies.operations.save'),
	});
	const removeOp = useBackendOperation(api.mail.savedReplies.remove, {
		label: () => t('shared.savedReplies.operations.remove'),
	});

	return {
		replies,
		canManage,
		isLoading: source.isLoading,
		error: source.error,
		refetch: source.refetch,
		create: (draft: SavedReplyDraft) => create(scope, draft),
		update: (replyId: Id<'mailSnippets'>, draft: Partial<SavedReplyDraft>) =>
			updateOp.run({ replyId, ...draft }),
		remove: (replyId: Id<'mailSnippets'>) => removeOp.run({ replyId }),
	};
}
