<script setup lang="ts">
/**
 * A team thread as a conversation between colleagues (plan §4.3): the
 * customer's emails as written (gray), the team's replies (white, with an
 * arrow), internal notes (tinted, "Internal") and what happened as thin
 * system lines, in one order. Older entries load on "Show earlier".
 *
 * The host renders each customer email through the `email` slot (the Team
 * Inbox card with its attachments and the agent's working, or the Postbox
 * reader's message); without it the email shows as a gray bubble with its
 * first lines. No AI sentence anywhere.
 */
import type { TeamStreamEntry } from '../../../../api/convex/mail/interpret/briefShape';
import { formatRelativeTime } from '~/utils/formatters';
import type { NoteMentionCandidate } from '~/utils/threadNotes';
import {
	buildStreamRows,
	type EmailEntry,
	type NoteEntry,
	type ReplyEntry,
} from '~/utils/teamStream';
import TeamStreamNote from './TeamStreamNote.vue';
import TeamStreamReply from './TeamStreamReply.vue';
import TeamStreamSystemLine from './TeamStreamSystemLine.vue';

const props = withDefaults(
	defineProps<{
		entries: readonly TeamStreamEntry[];
		hasEarlier?: boolean;
		loadingEarlier?: boolean;
		seenPosition?: { at: number; key: string } | null;
		viewerId?: string | null;
		memberName: (userId: string) => string;
		/** Note writes the viewer may make (Team Inbox: edit own, delete as admin). */
		canEditNote?: (entry: NoteEntry) => boolean;
		canDeleteNote?: (entry: NoteEntry) => boolean;
		canReact?: boolean;
		saveNote?: (entry: NoteEntry, body: string) => Promise<boolean>;
		candidatesFor?: (query: string) => NoteMentionCandidate[];
		undoingFollowUpId?: string | null;
	}>(),
	{
		hasEarlier: false,
		loadingEarlier: false,
		seenPosition: null,
		viewerId: null,
		canEditNote: () => false,
		canDeleteNote: () => false,
		canReact: true,
		saveNote: undefined,
		candidatesFor: () => [],
		undoingFollowUpId: null,
	}
);

const emit = defineEmits<{
	'load-earlier': [];
	'react-note': [entry: NoteEntry, emoji: string];
	'delete-note': [entry: NoteEntry];
	'undo-follow-up': [entry: ReplyEntry];
}>();

defineSlots<{
	email?: (props: { entry: EmailEntry }) => unknown;
	reply?: (props: { entry: ReplyEntry }) => unknown;
}>();

const { t } = useI18n();

const rows = computed(() =>
	buildStreamRows(props.entries, { seenPosition: props.seenPosition, viewerId: props.viewerId })
);

function replyAuthor(entry: ReplyEntry): string {
	if (entry.isAgent) return t('dashboard.inbox.detail.outbound.agent');
	return entry.authorUserId
		? props.memberName(entry.authorUserId)
		: t('dashboard.inbox.detail.outbound.yourTeam');
}

function saverFor(entry: NoteEntry) {
	if (!props.saveNote || !props.canEditNote(entry)) return undefined;
	return (body: string) => props.saveNote!(entry, body);
}
</script>

<template>
	<div class="flex flex-col gap-2.5" data-testid="team-thread-stream">
		<div v-if="hasEarlier || loadingEarlier" class="flex justify-center">
			<UiButton
				variant="ghost"
				size="sm"
				:loading="loadingEarlier"
				data-testid="team-stream-earlier"
				@click="emit('load-earlier')"
			>
				<Icon name="lucide:chevrons-up" class="size-3.5" />
				{{ t('components.team.stream.earlier') }}
			</UiButton>
		</div>

		<template v-for="row in rows" :key="row.key">
			<div
				v-if="row.kind === 'newDivider'"
				class="flex items-center gap-2 text-2xs font-medium uppercase tracking-wide text-brand"
				data-testid="team-stream-new"
			>
				<span class="h-px flex-1 bg-brand/30" />
				{{ t('components.team.stream.new') }}
				<span class="h-px flex-1 bg-brand/30" />
			</div>
			<TeamStreamSystemLine
				v-else-if="row.kind === 'opened'"
				:entries="row.entries"
				:member-name="memberName"
			/>
			<TeamStreamSystemLine
				v-else-if="row.entry.kind === 'activity'"
				:entries="[row.entry]"
				:member-name="memberName"
			/>
			<TeamStreamNote
				v-else-if="row.entry.kind === 'note'"
				:entry="row.entry"
				:can-delete="canDeleteNote(row.entry)"
				:save="saverFor(row.entry)"
				:candidates-for="candidatesFor"
				:can-react="canReact"
				@react="(emoji) => emit('react-note', row.entry as NoteEntry, emoji)"
				@delete="emit('delete-note', row.entry as NoteEntry)"
			/>
			<template v-else-if="row.entry.kind === 'teamReply'">
				<slot v-if="$slots['reply']" name="reply" :entry="row.entry" />
				<TeamStreamReply
					v-else
					:entry="row.entry"
					:author-label="replyAuthor(row.entry)"
					:undoing="undoingFollowUpId === row.entry.followUpId"
					@undo="emit('undo-follow-up', row.entry as ReplyEntry)"
				/>
			</template>
			<template v-else>
				<slot v-if="$slots['email']" name="email" :entry="row.entry" />
				<article
					v-else
					class="rounded-(--radius-card) bg-bg-surface px-4 py-3"
					data-testid="team-stream-email"
				>
					<header class="flex flex-wrap items-center gap-x-2 text-xs">
						<UiAvatar
							:name="row.entry.fromName ?? row.entry.fromEmail"
							deterministic-color
							size="xs"
						/>
						<span class="font-medium text-text-primary">{{
							row.entry.fromName ?? row.entry.fromEmail
						}}</span>
						<span class="text-text-tertiary"
							>{{ formatRelativeTime(row.entry.at) }} · {{ t('components.team.reply.email') }}</span
						>
					</header>
					<p class="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-primary">
						{{ row.entry.preview }}
					</p>
				</article>
			</template>
		</template>
	</div>
</template>
