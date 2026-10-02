<script setup lang="ts">
/**
 * One internal note in a Team Inbox thread. It sits between the messages, so
 * it must never read as mail: a warm tint, a lock and "Internal note" before
 * the author, and no mail icon. `@handle` mentions are emphasised the way chat
 * shows them.
 *
 * Its author can edit it in place (the composer opens on the text) and delete
 * it; an admin can delete anyone's. A deleted note keeps its place and reads
 * "Note deleted". Presentation only: the caller saves.
 */
import type { Id } from '@owlat/api/dataModel';
import { splitMentionSegments } from '@owlat/shared/chatMentions';
import { formatRelativeTime } from '~/utils/formatters';
import type { NoteMentionCandidate } from '~/utils/threadNotes';

export interface ThreadNoteView {
	_id: Id<'threadNotes'>;
	authorId: string;
	authorName: string | null;
	authorEmail: string | null;
	authorImage: string | null;
	body: string;
	createdAt: number;
	editedAt: number | null;
	isDeleted: boolean;
}

const props = withDefaults(
	defineProps<{
		note: ThreadNoteView;
		/** The viewer may edit it (they wrote it). */
		canEdit?: boolean;
		/** The viewer may delete it (they wrote it, or they are an admin). */
		canDelete?: boolean;
		save?: (body: string) => Promise<boolean>;
		candidatesFor?: (query: string) => NoteMentionCandidate[];
	}>(),
	{ canEdit: false, canDelete: false, save: undefined, candidatesFor: () => [] }
);

const emit = defineEmits<{ (e: 'delete'): void }>();

const { t, locale } = useI18n();

const editing = ref(false);
const author = computed(
	() =>
		props.note.authorName || props.note.authorEmail || t('components.inbox.notes.formerTeammate')
);
const segments = computed(() => splitMentionSegments(props.note.body));
const absoluteTime = computed(() =>
	new Date(props.note.createdAt).toLocaleString(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	})
);

// A mention notice links here (`#note-<id>`): bring the note into view.
const root = ref<HTMLElement | null>(null);
const route = useRoute();
onMounted(() => {
	if (route.hash === `#note-${props.note._id}`) root.value?.scrollIntoView?.({ block: 'center' });
});

async function saveEdit(body: string): Promise<boolean> {
	if (!props.save) return false;
	const saved = await props.save(body);
	if (saved) editing.value = false;
	return saved;
}
</script>

<template>
	<article
		:id="`note-${note._id}`"
		ref="root"
		class="ui-hover-reveal-host ml-6 rounded-(--radius-card) border border-warning/30 bg-warning/5 px-4 py-3 sm:ml-12"
		:aria-label="t('components.inbox.notes.ariaLabel', { name: author })"
		data-testid="thread-note"
	>
		<header class="flex items-center gap-2 text-xs">
			<UiAvatar
				:name="note.authorName ?? undefined"
				:email="note.authorEmail ?? undefined"
				:image="note.authorImage ?? undefined"
				deterministic-color
				size="xs"
			/>
			<span class="min-w-0 truncate font-medium text-text-primary">{{ author }}</span>
			<span class="inline-flex shrink-0 items-center gap-1 text-text-secondary">
				<Icon name="lucide:lock" class="size-3" aria-hidden="true" />
				{{ t('components.inbox.notes.badge') }}
			</span>
			<span aria-hidden="true" class="text-text-tertiary">·</span>
			<time
				class="shrink-0 text-text-tertiary"
				:datetime="new Date(note.createdAt).toISOString()"
				:title="absoluteTime"
			>
				{{ formatRelativeTime(note.createdAt) }}
			</time>
			<span v-if="note.editedAt && !note.isDeleted" class="shrink-0 text-text-tertiary">
				{{ t('components.inbox.notes.edited') }}
			</span>
			<span
				v-if="!note.isDeleted && !editing && (canEdit || canDelete)"
				class="ui-hover-reveal ml-auto flex shrink-0 items-center gap-0.5"
			>
				<button
					v-if="canEdit && save"
					type="button"
					class="rounded p-1 text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
					:title="t('components.inbox.notes.edit')"
					:aria-label="t('components.inbox.notes.edit')"
					data-testid="thread-note-edit"
					@click="editing = true"
				>
					<Icon name="lucide:pencil" class="size-3.5" />
				</button>
				<button
					v-if="canDelete"
					type="button"
					class="rounded p-1 text-text-tertiary hover:bg-bg-surface hover:text-error"
					:title="t('components.inbox.notes.delete')"
					:aria-label="t('components.inbox.notes.delete')"
					data-testid="thread-note-delete"
					@click="emit('delete')"
				>
					<Icon name="lucide:trash-2" class="size-3.5" />
				</button>
			</span>
		</header>

		<p
			v-if="note.isDeleted"
			class="mt-1.5 text-sm italic text-text-tertiary"
			data-testid="thread-note-deleted"
		>
			{{ t('components.inbox.notes.deleted') }}
		</p>
		<InboxNoteComposer
			v-else-if="editing && save"
			class="mt-2"
			:submit="saveEdit"
			:candidates-for="candidatesFor"
			:initial-body="note.body"
			editing
			autofocus
			@cancel="editing = false"
		/>
		<p
			v-else
			class="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-primary"
			data-testid="thread-note-body"
		>
			<template v-for="(segment, index) in segments" :key="index">
				<span v-if="segment.kind === 'mention'" class="font-medium text-brand">{{
					segment.value
				}}</span>
				<template v-else>{{ segment.value }}</template>
			</template>
		</p>
	</article>
</template>
