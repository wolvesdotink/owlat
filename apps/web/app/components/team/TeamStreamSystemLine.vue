<script setup lang="ts">
/**
 * What happened, as a thin line in the team stream (plan §4.3): an action
 * closed, a reply held, a file added. Several new actions noted together
 * read as one line. Each line says how Owlat knows it (recorded, you said,
 * from their email). Never an AI sentence about the customer's mail.
 */
import type { ActivityEntry } from '~/utils/teamStream';
import { briefShortDate } from '~/utils/threadBriefContext';
import { systemLineText } from '~/utils/teamStreamText';

const props = defineProps<{
	entries: readonly ActivityEntry[];
	/** A teammate's display name for a user id. */
	memberName: (userId: string) => string;
}>();

const { t, locale } = useI18n();

const first = computed(() => props.entries[0]!);
const text = computed(() => systemLineText(props.entries, { t, memberName: props.memberName }));
</script>

<template>
	<p
		class="flex flex-wrap items-baseline justify-center gap-x-1.5 px-2 py-0.5 text-center text-xs text-text-tertiary"
		data-testid="team-stream-system"
		:data-type="first.activity.type"
	>
		<span class="font-mono">{{ briefShortDate(first.at, locale) }}</span>
		<span aria-hidden="true">·</span>
		<span class="text-text-secondary">{{ text }}</span>
		<span
			class="rounded border border-border-subtle px-1 font-mono text-[10px]"
			data-testid="team-stream-provenance"
			>{{ t(`components.brief.activity.provenance.${first.activity.provenance}`) }}</span
		>
	</p>
</template>
