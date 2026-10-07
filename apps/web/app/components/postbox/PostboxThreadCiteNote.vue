<script setup lang="ts">
/**
 * The line over the Conversation while it shows the source of a line of the
 * brief (plan §4.2): what is being shown, and the way back to the Overview.
 * Going back writes no preference; the cite was for this visit only.
 */
import type { PostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';

const props = defineProps<{ state: PostboxReaderBrief }>();

const { t } = useI18n();
const cited = computed(() => props.state.cited.value);
</script>

<template>
	<p
		v-if="cited"
		class="flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary"
		data-testid="thread-cite-note"
	>
		<span>{{ t('components.brief.cite.showing', { label: cited.label }) }}</span>
		<span aria-hidden="true">·</span>
		<button type="button" class="text-brand hover:underline" @click="state.backToOverview()">
			{{ t('components.brief.cite.back') }}
		</button>
	</p>
</template>
