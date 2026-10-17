<script setup lang="ts">
/**
 * The calm reader's meta row (read on arrival §3): whatever the host puts in
 * front (the item you wait on, or "Reading this thread now"), then Full brief,
 * Read the exact wording, Why here? and Details, separated by quiet dots, and
 * a summary of what Details holds on the right. Shared by the brief strip and
 * the slim line that stands in for it. Presentational: everything emits.
 *
 * Each dot belongs to the item before it (one flex item, the slot's lead glues
 * its dot with a no-break space), so a wrapped line never starts with "·".
 */
const props = defineProps<{
	showFullBrief?: boolean;
	hasExactWording?: boolean;
	showWhyHere?: boolean;
	detailsOpen: boolean;
	summary?: string | null;
}>();

const emit = defineEmits<{
	'toggle-details': [];
	'why-here': [anchor: HTMLElement | null];
	'full-brief': [];
	'exact-wording': [];
}>();

const { t } = useI18n();
const whyEl = ref<HTMLElement | null>(null);

type Link = { id: string; label: string; run: () => void; testid: string };
const links = computed<Link[]>(() => [
	...(props.showFullBrief
		? [
				{
					id: 'full',
					label: t('postbox.reader.strip.fullBrief'),
					run: () => emit('full-brief'),
					testid: 'strip-full-brief',
				},
			]
		: []),
	...(props.hasExactWording
		? [
				{
					id: 'exact',
					label: t('postbox.reader.strip.exactWording'),
					run: () => emit('exact-wording'),
					testid: 'strip-exact-wording',
				},
			]
		: []),
	...(props.showWhyHere
		? [
				{
					id: 'why',
					label: t('postbox.reader.strip.whyHere'),
					run: () => emit('why-here', whyEl.value),
					testid: 'strip-why-here',
				},
			]
		: []),
]);

const LINK = 'text-text-secondary hover:text-text-primary hover:underline';
</script>

<template>
	<p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-tertiary">
		<slot />
		<span
			v-for="link in links"
			:key="link.id"
			class="inline-flex items-center gap-x-1.5 whitespace-nowrap"
		>
			<button
				:ref="link.id === 'why' ? (el) => (whyEl = el as HTMLElement | null) : undefined"
				type="button"
				:class="LINK"
				:data-testid="link.testid"
				@click="link.run"
			>
				{{ link.label }}
			</button>
			<span aria-hidden="true">·</span>
		</span>
		<button
			type="button"
			:class="LINK"
			:aria-expanded="detailsOpen"
			data-testid="strip-details"
			@click="emit('toggle-details')"
		>
			{{ t('postbox.reader.strip.details') }}
		</button>
		<span v-if="summary" class="ml-auto" data-testid="strip-summary">{{ summary }}</span>
	</p>
</template>
