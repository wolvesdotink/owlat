<script setup lang="ts">
/**
 * What an open count leaves out. Apple Mail Privacy Protection and security
 * scanners fetch the tracking pixel without anyone reading the email; those
 * fetches are counted apart and named here, so the open count reads as people.
 * Opens counted before that split existed get a caveat instead: they may still
 * include those fetches. Used by the campaign report and the Marketing overview.
 */
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	/** Automated opens left out of the open count. */
	automatedOpens: number;
	/** False when some of the opens were counted before automated opens were split out. */
	isAutomatedOpenFiltered: boolean;
}>();

const { t, locale } = useI18n();

const lines = computed(() => {
	const out: string[] = [];
	if (props.automatedOpens > 0) {
		out.push(
			t('components.campaigns.automatedOpens.excluded', props.automatedOpens, {
				named: { count: formatNumber(props.automatedOpens, locale.value) },
			})
		);
	}
	if (!props.isAutomatedOpenFiltered) {
		out.push(t('components.campaigns.automatedOpens.unfiltered'));
	}
	return out;
});
</script>

<template>
	<div v-if="lines.length > 0" class="flex flex-col gap-1">
		<p
			v-for="line in lines"
			:key="line"
			class="flex items-start gap-1.5 text-xs text-text-tertiary"
		>
			<Icon name="lucide:info" class="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
			<span>{{ line }}</span>
		</p>
	</div>
</template>
