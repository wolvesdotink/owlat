<script setup lang="ts">
/**
 * Who else has this email open in the editor (co-editing, see
 * docs/adr/0071-email-coediting.md): an avatar stack for the editor toolbar,
 * each avatar in the colour that outlines that person's block on the canvas,
 * plus a quiet "not synced" hint while this tab's edits cannot reach the
 * server. Renders nothing while the editor is not live.
 */
import type { EditorPerson } from '~/composables/useEmailEditorPresence';

const props = defineProps<{
	people: EditorPerson[];
	/** Edits are waiting to be sent (the connection is down). */
	isOffline?: boolean;
}>();

const { t } = useI18n();

const MAX_AVATARS = 4;
const shown = computed(() => props.people.slice(0, MAX_AVATARS));
const overflow = computed(() => Math.max(0, props.people.length - MAX_AVATARS));

function title(person: EditorPerson): string {
	return t(
		person.isEditing
			? 'components.email.editorPresence.titleEditing'
			: 'components.email.editorPresence.titleViewing',
		{ name: person.name }
	);
}
</script>

<template>
	<div
		v-if="people.length > 0 || isOffline"
		class="flex items-center gap-2"
		data-testid="editor-presence"
	>
		<span
			v-if="isOffline"
			class="inline-flex items-center gap-1 text-xs text-warning"
			:title="t('components.email.editorPresence.offlineTitle')"
		>
			<Icon name="lucide:cloud-off" class="w-3.5 h-3.5" />
			<span class="max-2xl:sr-only">{{ t('components.email.editorPresence.offline') }}</span>
		</span>
		<div
			v-if="people.length > 0"
			class="flex -space-x-1.5"
			role="list"
			:aria-label="t('components.email.editorPresence.label')"
		>
			<span
				v-for="person in shown"
				:key="person.userId"
				role="listitem"
				class="rounded-full ring-2"
				:style="{ '--tw-ring-color': person.color }"
				:title="title(person)"
				:aria-label="title(person)"
			>
				<UiAvatar
					:name="person.name"
					:email="person.email"
					:image="person.image"
					size="sm"
					deterministic-color
				/>
			</span>
			<span
				v-if="overflow > 0"
				role="listitem"
				class="w-6 h-6 rounded-full border border-border-subtle bg-bg-surface text-text-tertiary text-[0.625rem] font-medium flex items-center justify-center"
				:title="t('components.email.editorPresence.more', { count: overflow })"
			>
				+{{ overflow }}
			</span>
		</div>
	</div>
</template>
