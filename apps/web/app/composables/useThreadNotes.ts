import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { noteMentionCandidates } from '~/utils/threadNotes';
import { useOrganization } from '~/composables/useOrganization';

/**
 * A Team Inbox thread's internal notes: the live list, the three writes, and
 * the teammates a note can mention. Shared by the thread page (notes between
 * the messages, the Note tab under them) and Answer mode (the Note tab beside
 * the reply), so both read one subscription and toast with one set of labels.
 *
 * `enabled` gates the subscription: the shared inbox is owner/admin only, and a
 * member who lands on the page would read an empty list anyway.
 */
export function useThreadNotes(
	threadId: Ref<Id<'conversationThreads'>>,
	options: { enabled: () => boolean }
) {
	const { t } = useI18n();
	const { user } = useAuth();
	const { members } = useOrganization();

	const { data, isLoading, error, refetch } = useConvexQuery(api.inbox.notes.listForThread, () =>
		options.enabled() ? { threadId: threadId.value } : 'skip'
	);
	const notes = computed(() => data.value ?? []);
	const liveCount = computed(() => notes.value.filter((note) => !note.isDeleted).length);

	const create = useBackendOperation(api.inbox.notes.create, {
		label: () => t('components.inbox.notes.createOperation'),
	});
	const update = useBackendOperation(api.inbox.notes.update, {
		label: () => t('components.inbox.notes.updateOperation'),
	});
	const remove = useBackendOperation(api.inbox.notes.remove, {
		label: () => t('components.inbox.notes.deleteOperation'),
	});

	/** Post a note; resolves whether it was saved (a failure has toasted). */
	async function post(body: string): Promise<boolean> {
		return (await create.run({ threadId: threadId.value, body })).ok;
	}
	async function edit(noteId: Id<'threadNotes'>, body: string): Promise<boolean> {
		return (await update.run({ noteId, body })).ok;
	}
	async function destroy(noteId: Id<'threadNotes'>): Promise<boolean> {
		return (await remove.run({ noteId })).ok;
	}

	/** Who the @-picker offers for a typed fragment. */
	const candidatesFor = (query: string) =>
		noteMentionCandidates(members.value, user.value?.id ?? null, query);

	return {
		notes,
		liveCount,
		isLoading,
		error,
		refetch,
		post,
		edit,
		destroy,
		isPosting: create.isLoading,
		currentUserId: computed(() => user.value?.id ?? null),
		candidatesFor,
	};
}

export type ThreadNotes = ReturnType<typeof useThreadNotes>;
