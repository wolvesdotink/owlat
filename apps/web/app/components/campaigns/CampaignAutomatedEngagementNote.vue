<script setup lang="ts">
/**
 * What the open and click counts do not count. Apple Mail Privacy Protection
 * and security scanners fetch the tracking pixel without anyone reading the
 * email, and security gateways follow every link to inspect it. Those requests
 * are counted apart, per email, and named here, so the counts read as people.
 * An email with automated traffic may still have been opened or clicked by its
 * reader later, so the numbers are not what the counts lost.
 * Counts from before that split existed get a caveat instead: they may still
 * include those requests. Used by the campaign report and the Marketing overview.
 */
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	/** Emails whose tracking pixel was fetched automatically at least once. */
	automatedOpens: number;
	/** False when some of the opens were counted before automated opens were split out. */
	isAutomatedOpenFiltered: boolean;
	/** Emails with at least one link followed automatically. */
	automatedClicks: number;
	/** False when some of the clicks were counted before automated clicks were split out. */
	isAutomatedClickFiltered: boolean;
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
	if (props.automatedClicks > 0) {
		out.push(
			t('components.campaigns.automatedClicks.excluded', props.automatedClicks, {
				named: { count: formatNumber(props.automatedClicks, locale.value) },
			})
		);
	}
	if (!props.isAutomatedOpenFiltered && !props.isAutomatedClickFiltered) {
		out.push(t('components.campaigns.automatedClicks.unfilteredWithOpens'));
	} else if (!props.isAutomatedOpenFiltered) {
		out.push(t('components.campaigns.automatedOpens.unfiltered'));
	} else if (!props.isAutomatedClickFiltered) {
		out.push(t('components.campaigns.automatedClicks.unfiltered'));
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
