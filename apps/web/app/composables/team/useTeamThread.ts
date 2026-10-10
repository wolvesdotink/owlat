/**
 * Everything a team thread surface needs around its stream (SPEC §7 "Team"),
 * shared by the Team Inbox page, the shared-mailbox reader and team Answer
 * mode: the stream, the pinned actions, the teammates (for owners, mentions
 * and names), and the writes: notes, note reactions, Claim / Assign and the
 * other item reactions.
 *
 * Notes go to the surface's own store: `inbox.notes` for a Team Inbox thread,
 * the thread's discussion (`chat.mailDiscussion`) for a shared mailbox.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { useOrganization } from '~/composables/useOrganization';
import { useTeamItemActions } from '~/composables/team/useTeamItemActions';
import { useTeamOpenItems } from '~/composables/team/useTeamOpenItems';
import { useTeamStream, type TeamStreamTarget } from '~/composables/team/useTeamStream';
import { useTeamCite } from '~/composables/team/useTeamCite';
import type { TeamItemAction, TeamMember } from '~/components/team/TeamOpenItem.vue';
import type { BriefAction } from '~/utils/threadBriefItems';
import { linkableItems, noteCountsByItem, type NoteEntry } from '~/utils/teamStream';
import { noteMentionCandidates } from '~/utils/threadNotes';

export function useTeamThread(opts: {
	target: () => TeamStreamTarget | null;
	/** Read at all (the Team Inbox is owner/admin only). */
	enabled?: () => boolean;
	/** Open Answer mode for a replying reaction on an item. */
	onReply: (item: BriefItemView, action: BriefAction) => void;
}) {
	const { t } = useI18n();
	const { user } = useAuth();
	const { members: orgMembers, fetchMembers } = useOrganization();
	// Owners, @mentions and names need the roster; a page that already loaded it is not asked again.
	onMounted(() => void fetchMembers());
	const target = computed(() => (opts.enabled?.() === false ? null : opts.target()));

	const stream = useTeamStream({ target: () => target.value });
	const openItems = useTeamOpenItems({ target: () => target.value });
	const actions = useTeamItemActions({ onReply: opts.onReply });

	const viewerId = computed(() => user.value?.id ?? null);
	const members = computed<TeamMember[]>(() =>
		orgMembers.value.map((m) => ({
			userId: m.userId,
			name: m.user.name ?? null,
			email: m.user.email ?? null,
			image: m.user.image ?? null,
		}))
	);
	function memberName(userId: string): string {
		const m = orgMembers.value.find((x) => x.userId === userId);
		return m ? m.user.name || m.user.email : t('components.team.items.formerTeammate');
	}
	const candidatesFor = (query: string) =>
		noteMentionCandidates(orgMembers.value, viewerId.value, query);
	const noteCounts = computed(() => noteCountsByItem(stream.entries.value));
	const items = computed(() => linkableItems(openItems.view.value));

	// ── Notes ──
	const label = () => t('components.team.note.operation');
	const createTeamNote = useBackendOperation(api.inbox.notes.create, { label });
	const updateTeamNote = useBackendOperation(api.inbox.notes.update, { label });
	const removeTeamNote = useBackendOperation(api.inbox.notes.remove, { label });
	const reactTeamNote = useBackendOperation(api.inbox.notes.toggleReaction, { label });
	const postDiscussion = useBackendOperation(api.chat.mailDiscussion.post, { label });
	const reactDiscussion = useBackendOperation(api.chat.mailDiscussion.toggleReaction, { label });

	async function postNote(body: string, threadItemId: string | null): Promise<boolean> {
		const ref = target.value;
		if (!ref) return false;
		const link = threadItemId ? { threadItemId: threadItemId as Id<'threadItems'> } : {};
		const result =
			ref.kind === 'team'
				? await createTeamNote.run({ threadId: ref.id, body, ...link })
				: await postDiscussion.run({ threadId: ref.id, body, ...link });
		return result.ok;
	}
	async function editNote(entry: NoteEntry, body: string): Promise<boolean> {
		if (entry.noteSource !== 'threadNote') return false;
		return (await updateTeamNote.run({ noteId: entry.noteId as Id<'threadNotes'>, body })).ok;
	}
	async function deleteNote(entry: NoteEntry): Promise<boolean> {
		if (entry.noteSource !== 'threadNote') return false;
		return (await removeTeamNote.run({ noteId: entry.noteId as Id<'threadNotes'> })).ok;
	}
	async function reactNote(entry: NoteEntry, emoji: string): Promise<void> {
		if (entry.noteSource === 'threadNote') {
			await reactTeamNote.run({ noteId: entry.noteId as Id<'threadNotes'>, emoji });
		} else {
			await reactDiscussion.run({ messageId: entry.noteId as Id<'chatMessages'>, emoji });
		}
	}
	const canEditNote = (entry: NoteEntry) =>
		entry.noteSource === 'threadNote' && entry.authorId === viewerId.value;

	// ── Items ──
	async function act(item: BriefItemView, action: TeamItemAction): Promise<void> {
		if (action === 'claim') await actions.claim(item);
		else await actions.react(item, action);
	}

	/** Source markers for the team's brief components (strip, Answer mode's plan). */
	const cite = useTeamCite({ stream, view: openItems.view, memberName });

	return {
		stream,
		cite,
		openItems: openItems.view,
		viewerId,
		members,
		memberName,
		candidatesFor,
		noteCounts,
		items,
		postNote,
		editNote,
		deleteNote,
		reactNote,
		canEditNote,
		act,
		assign: actions.assign,
	};
}

export type TeamThread = ReturnType<typeof useTeamThread>;
