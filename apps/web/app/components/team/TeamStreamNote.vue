<script setup lang="ts">
/**
 * One internal note in the team stream (plan §4.3): a tinted team message
 * with an "Internal" chip, so it never reads as mail. `@handle` mentions are
 * emphasised, a `#` link names the action it is about ("on Refund €129.00"),
 * and teammates react with an emoji.
 *
 * On the Team Inbox its author can edit it and an admin can delete it (the
 * caller passes `save` / `canDelete`); a deleted note keeps its place and
 * reads "Note deleted". Presentation only: the caller saves.
 */
import { splitMentionSegments } from '@owlat/shared/chatMentions';
import { formatRelativeTime } from '~/utils/formatters';
import type { NoteMentionCandidate } from '~/utils/threadNotes';
import { QUICK_REACTIONS, type NoteEntry } from '~/utils/teamStream';

const props = withDefaults(
	defineProps<{
		entry: NoteEntry;
		canDelete?: boolean;
		/** Save an edit; only for the note's author. */
		save?: (body: string) => Promise<boolean>;
		candidatesFor?: (query: string) => NoteMentionCandidate[];
		/** Reactions can be added (the viewer may post here). */
		canReact?: boolean;
	}>(),
	{ canDelete: false, save: undefined, candidatesFor: () => [], canReact: true }
);

const emit = defineEmits<{ react: [emoji: string]; delete: [] }>();

const { t, locale } = useI18n();

const editing = ref(false);
const picking = ref(false);
const author = computed(
	() =>
		props.entry.authorName || props.entry.authorEmail || t('components.team.note.formerTeammate')
);
const segments = computed(() => splitMentionSegments(props.entry.body));
const absoluteTime = computed(() =>
	new Date(props.entry.at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
);

async function saveEdit(body: string): Promise<boolean> {
	if (!props.save) return false;
	const saved = await props.save(body);
	if (saved) editing.value = false;
	return saved;
}

function react(emoji: string) {
	picking.value = false;
	emit('react', emoji);
}
</script>

<template>
	<article
		:id="`note-${entry.noteId}`"
		class="ui-hover-reveal-host rounded-(--radius-card) border border-warning/30 bg-warning/5 px-4 py-3"
		:aria-label="t('components.team.note.ariaLabel', { name: author })"
		data-testid="team-stream-note"
	>
		<header class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
			<UiAvatar
				:name="entry.authorName ?? undefined"
				:email="entry.authorEmail ?? undefined"
				:image="entry.authorImage ?? undefined"
				deterministic-color
				size="xs"
			/>
			<span class="min-w-0 truncate font-medium text-text-primary">{{ author }}</span>
			<time
				class="shrink-0 text-text-tertiary"
				:datetime="new Date(entry.at).toISOString()"
				:title="absoluteTime"
			>
				{{ formatRelativeTime(entry.at) }}
			</time>
			<span
				class="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-px text-2xs font-medium text-warning"
				data-testid="team-note-internal"
			>
				<Icon name="lucide:lock" class="size-3" aria-hidden="true" />
				{{ t('components.team.note.internal') }}
			</span>
			<span
				v-if="entry.threadItemId && !entry.isDeleted"
				class="inline-flex min-w-0 max-w-full items-center gap-1 text-text-tertiary"
				data-testid="team-note-item"
			>
				{{ t('components.team.note.on') }}
				<span
					class="truncate rounded-full bg-brand-subtle px-2 py-px text-2xs font-medium text-brand"
				>
					{{ entry.threadItemText ?? t('components.team.note.removedItem') }}
				</span>
			</span>
			<span v-if="entry.editedAt && !entry.isDeleted" class="shrink-0 text-text-tertiary">
				{{ t('components.team.note.edited') }}
			</span>
			<span
				v-if="!entry.isDeleted && !editing && (save || canDelete)"
				class="ui-hover-reveal ml-auto flex shrink-0 items-center gap-0.5"
			>
				<button
					v-if="save"
					type="button"
					class="rounded p-1 text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
					:title="t('components.team.note.edit')"
					:aria-label="t('components.team.note.edit')"
					data-testid="team-note-edit"
					@click="editing = true"
				>
					<Icon name="lucide:pencil" class="size-3.5" />
				</button>
				<button
					v-if="canDelete"
					type="button"
					class="rounded p-1 text-text-tertiary hover:bg-bg-surface hover:text-error"
					:title="t('components.team.note.delete')"
					:aria-label="t('components.team.note.delete')"
					data-testid="team-note-delete"
					@click="emit('delete')"
				>
					<Icon name="lucide:trash-2" class="size-3.5" />
				</button>
			</span>
		</header>

		<p v-if="entry.isDeleted" class="mt-1.5 text-sm italic text-text-tertiary">
			{{ t('components.team.note.deleted') }}
		</p>
		<InboxNoteComposer
			v-else-if="editing && save"
			class="mt-2"
			:submit="saveEdit"
			:candidates-for="candidatesFor"
			:initial-body="entry.body"
			editing
			autofocus
			@cancel="editing = false"
		/>
		<p
			v-else
			class="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-primary"
			data-testid="team-note-body"
		>
			<template v-for="(segment, index) in segments" :key="index">
				<span v-if="segment.kind === 'mention'" class="font-medium text-brand">{{
					segment.value
				}}</span>
				<template v-else>{{ segment.value }}</template>
			</template>
		</p>

		<div
			v-if="!entry.isDeleted && (entry.reactions.length > 0 || canReact)"
			class="mt-2 flex flex-wrap items-center gap-1"
			data-testid="team-note-reactions"
		>
			<button
				v-for="reaction in entry.reactions"
				:key="reaction.emoji"
				type="button"
				class="inline-flex items-center gap-1 rounded-full border px-2 py-px text-xs"
				:class="
					reaction.isMine
						? 'border-brand/40 bg-brand-subtle text-text-primary'
						: 'border-border-subtle bg-bg-elevated text-text-secondary'
				"
				:aria-pressed="reaction.isMine"
				:disabled="!canReact"
				:title="t('components.team.note.reactWith', { emoji: reaction.emoji })"
				@click="react(reaction.emoji)"
			>
				<span aria-hidden="true">{{ reaction.emoji }}</span>
				<span class="tabular-nums">{{ reaction.count }}</span>
			</button>
			<span v-if="canReact" class="relative">
				<button
					type="button"
					class="ui-hover-reveal inline-flex items-center rounded-full border border-border-subtle px-1.5 py-px text-text-tertiary hover:text-text-primary"
					:aria-label="t('components.team.note.addReaction')"
					:aria-expanded="picking"
					data-testid="team-note-add-reaction"
					@click="picking = !picking"
				>
					<Icon name="lucide:smile-plus" class="size-3.5" />
				</button>
				<span
					v-if="picking"
					class="absolute left-0 top-full z-10 mt-1 flex gap-0.5 rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-md"
					role="menu"
				>
					<button
						v-for="emoji in QUICK_REACTIONS"
						:key="emoji"
						type="button"
						role="menuitem"
						class="rounded px-1.5 py-0.5 text-sm hover:bg-bg-surface"
						:aria-label="t('components.team.note.reactWith', { emoji })"
						@click="react(emoji)"
					>
						{{ emoji }}
					</button>
				</span>
			</span>
		</div>
	</article>
</template>
