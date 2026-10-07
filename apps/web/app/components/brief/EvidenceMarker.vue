<script setup lang="ts">
/**
 * A source marker after a line of the brief: the sender's initials and the
 * message date ("JW 7 Oct"). Clicking it shows the quoted words in the
 * Conversation (plan §4.2). The accessible name says whose message and when,
 * and the tooltip carries the quote itself.
 *
 * Reads the sender and date from the thread through `BRIEF_CONTEXT`; a message
 * that is not loaded yet still gets a marker, just without the initials.
 */
import type { EvidenceView } from '../../../../api/convex/mail/interpret/briefShape';
import { BRIEF_CONTEXT, briefShortDate } from '~/utils/threadBriefContext';
import { initialsOf } from '~/utils/threadBriefItems';

const props = defineProps<{
	evidence: EvidenceView;
	/** The item or fact id (or `latest-<n>`) the marker belongs to. */
	citeRef: string;
	quoteIndex: number;
}>();

const { t, locale } = useI18n();
const context = inject(BRIEF_CONTEXT, null);

const source = computed(() => context?.sourceOf(props.evidence.source.id));
const date = computed(() => (source.value?.at ? briefShortDate(source.value.at, locale.value) : ''));
const text = computed(() => {
	const who = source.value ? initialsOf(source.value.name, source.value.email) : '';
	return [who, date.value].filter(Boolean).join(' ') || '·';
});
const label = computed(() => {
	const name = source.value?.name || source.value?.email;
	return name && date.value
		? t('components.brief.evidence.label', { name, date: date.value })
		: t('components.brief.evidence.unknown');
});

function onClick() {
	context?.cite(props.citeRef, props.quoteIndex);
}
</script>

<template>
	<button
		type="button"
		class="ml-1 inline-flex items-center rounded bg-bg-surface px-1 align-[1px] font-mono text-[10px] leading-4 text-text-tertiary hover:bg-brand hover:text-text-inverse focus-visible:bg-brand focus-visible:text-text-inverse"
		:aria-label="label"
		:title="evidence.quote ? `“${evidence.quote}”` : label"
		data-testid="evidence-marker"
		@click="onClick"
	>
		{{ text }}
	</button>
</template>
