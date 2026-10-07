<script setup lang="ts">
/** The "add a reaction" button of a team note, with the quick emojis it offers. */
import { QUICK_REACTIONS } from '~/utils/teamStream';

const emit = defineEmits<{ pick: [emoji: string] }>();

const { t } = useI18n();
const open = ref(false);

function pick(emoji: string) {
	open.value = false;
	emit('pick', emoji);
}
</script>

<template>
	<span class="relative inline-flex">
		<button
			type="button"
			class="inline-flex items-center rounded-full border border-border-subtle px-1.5 py-px text-text-tertiary hover:text-text-primary"
			:aria-label="t('components.team.note.addReaction')"
			:aria-expanded="open"
			data-testid="team-note-add-reaction"
			@click="open = !open"
		>
			<Icon name="lucide:smile-plus" class="size-3.5" />
		</button>
		<span
			v-if="open"
			class="absolute right-0 top-full z-10 mt-1 flex gap-0.5 rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-md"
			role="menu"
		>
			<button
				v-for="emoji in QUICK_REACTIONS"
				:key="emoji"
				type="button"
				role="menuitem"
				class="rounded px-1.5 py-0.5 text-sm hover:bg-bg-surface"
				:aria-label="t('components.team.note.reactWith', { emoji })"
				@click="pick(emoji)"
			>
				{{ emoji }}
			</button>
		</span>
	</span>
</template>
