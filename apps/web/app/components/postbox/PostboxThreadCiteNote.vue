<script setup lang="ts">
/**
 * The line over the conversation while it shows the source of a line of the
 * brief (plan §4.2): what is being shown, and a way to drop the mark. While
 * the cited message is still being loaded (an earlier page) it says so, and
 * when it cannot be reached it says that instead of showing nothing. The cite
 * was for this visit only; dropping it writes nothing.
 */
import type { PostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';

const props = defineProps<{ state: PostboxReaderBrief }>();

const { t } = useI18n();
const cited = computed(() => props.state.cited.value);
const citeState = computed(() => props.state.citeState.value);
</script>

<template>
	<p
		v-if="cited"
		class="flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary"
		data-testid="thread-cite-note"
	>
		<span>{{ t('components.brief.cite.showing', { label: cited.label }) }}</span>
		<span v-if="citeState === 'loading'" data-testid="cite-loading">
			· {{ t('components.brief.cite.loading') }}</span
		>
		<span
			v-else-if="citeState === 'unreachable'"
			class="text-warning"
			data-testid="cite-unreachable"
		>
			· {{ t('components.brief.cite.unreachable') }}</span
		>
		<span aria-hidden="true">·</span>
		<button type="button" class="text-brand hover:underline" @click="state.clearCite()">
			{{ t('postbox.reader.cite.clear') }}
		</button>
	</p>
</template>
