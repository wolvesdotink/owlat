<script setup lang="ts">
import {
	CONVERSATION_STATUS_LABEL,
	CONVERSATION_STATUS_TONE,
	PULSING_STATUSES,
	type ConversationStatus,
} from '~/utils/conversationStatus';

/**
 * One conversation status: a round dot plus its label, in the status's tone.
 * The label is always rendered (or, with `dotOnly`, carried by the accessible
 * name), so a status never relies on colour alone.
 */
const props = defineProps<{ status: ConversationStatus; dotOnly?: boolean }>();
const { t } = useI18n();
const label = computed(() => t(CONVERSATION_STATUS_LABEL[props.status]));
</script>

<template>
	<span
		class="inline-flex items-center gap-1 text-2xs font-medium leading-4"
		:class="CONVERSATION_STATUS_TONE[status]"
		:title="dotOnly ? label : undefined"
		:aria-label="dotOnly ? label : undefined"
		:role="dotOnly ? 'img' : undefined"
	>
		<span
			class="size-1.5 shrink-0 rounded-full bg-current"
			:class="PULSING_STATUSES.has(status) ? 'animate-pulse motion-reduce:animate-none' : ''"
			aria-hidden="true"
		/>
		<span v-if="!dotOnly">{{ label }}</span>
	</span>
</template>
