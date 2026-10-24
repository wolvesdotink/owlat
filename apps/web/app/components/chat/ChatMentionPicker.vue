<script setup lang="ts">
/**
 * The `@` teammate suggestions over a text box (chat, internal notes). The
 * box keeps focus: its host forwards keydown to `handleKeydown` first (↑ ↓
 * move, Enter or Tab picks, Escape dismisses) and spreads `fieldAttrs` on the
 * box. Trigger detection and insertion stay with the host.
 */
import type { SuggestionListHandle } from '@owlat/ui/utils/listboxField';

interface Candidate {
	memberId: string;
	name: string | null;
	email: string | null;
	image: string | null;
	handle: string | null;
}

interface Props {
	candidates: Candidate[];
	/** The text box the list sits over. */
	anchor?: HTMLElement | null;
}

const props = withDefaults(defineProps<Props>(), { anchor: null });
const emit = defineEmits<{
	pick: [handle: string];
	/** Escape or a press elsewhere: stop offering until the fragment changes. */
	dismiss: [];
}>();

const { t } = useI18n();

const handleOf = (candidate: Candidate) =>
	candidate.handle ?? candidate.email?.split('@')[0] ?? candidate.memberId;

const popover = ref<SuggestionListHandle | null>(null);

defineExpose({
	handleKeydown: (event: KeyboardEvent) => popover.value?.handleKeydown(event) ?? false,
	fieldAttrs: computed(() => popover.value?.fieldAttrs ?? {}),
});
</script>

<template>
	<UiSuggestionPopover
		ref="popover"
		:open="props.candidates.length > 0"
		:options="candidates"
		:option-key="(candidate: Candidate) => candidate.memberId"
		:label="t('components.chat.chatMentionPicker.listLabel')"
		:anchor="anchor"
		:field="anchor"
		side="top"
		match-anchor-width
		class="max-h-64 shadow-xl"
		option-class="flex items-center gap-2 px-3 py-1.5 text-sm data-highlighted:bg-bg-surface"
		@select="(candidate: Candidate) => emit('pick', handleOf(candidate))"
		@update:open="(open: boolean) => !open && emit('dismiss')"
	>
		<template #option="{ option }">
			<UiAvatar :name="option.name" :email="option.email" :image="option.image" size="sm" />
			<span class="text-text-primary">{{ option.name ?? option.email ?? option.memberId }}</span>
			<span v-if="option.handle" class="text-text-tertiary text-xs">@{{ option.handle }}</span>
		</template>
	</UiSuggestionPopover>
</template>
