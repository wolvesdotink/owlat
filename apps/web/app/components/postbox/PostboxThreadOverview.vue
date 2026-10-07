<script setup lang="ts">
/**
 * The reader's Overview of a personal thread (SPEC §7, plan §4.1): the counts
 * line, the thread brief, the way to the whole conversation, and the thread's
 * verbs: Reply (covering every open item), Archive, Snooze and "Ask about
 * this thread", whose grounded Q&A opens right here (it used to live in the
 * one-line AI strip this replaces).
 *
 * On a phone the verbs sit in a sticky bar under the thumb (plan §7).
 * Everything it does is an emit; the reader runs it.
 */
import type { PostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';
import { briefShortDate } from '~/utils/threadBriefContext';
import { formatCompactRelativeTime } from '~/utils/formatters';
import ThreadBrief from '~/components/brief/ThreadBrief.vue';

const props = defineProps<{
	/** The reader's brief state (usePostboxReaderBrief). */
	state: PostboxReaderBrief;
	/** The loaded conversation, oldest first. */
	messages: readonly { _id: string; fromName?: string; fromAddress: string; receivedAt: number }[];
	messageCount: number;
}>();

const emit = defineEmits<{
	action: [action: 'reply' | 'archive' | 'snooze'];
}>();

const { t, locale } = useI18n();
const { isEnabled } = useFeatureFlag();
const aiEnabled = computed(() => isEnabled('ai'));
const brief = computed(() => props.state.brief.value);
const latest = computed(() => props.messages[props.messages.length - 1]);
const firstAt = computed(() => props.messages[0]?.receivedAt);
const asking = ref(false);
watch(
	() => latest.value?._id,
	() => {
		asking.value = false;
	}
);

const openForYou = computed(
	() => brief.value?.forYou.filter((i) => i.status === 'open').length ?? 0
);
const waiting = computed(() => brief.value?.counts.waitingOnOthers ?? 0);
const latestName = computed(() => latest.value?.fromName || latest.value?.fromAddress || '');
const latestNote = computed(() =>
	latest.value ? `${latestName.value} · ${formatCompactRelativeTime(latest.value.receivedAt)}` : ''
);
const span = computed(() => {
	if (!firstAt.value || !latest.value) return '';
	return t(
		'components.brief.conversation.span',
		{
			count: props.messageCount,
			from: briefShortDate(firstAt.value, locale.value),
			to: briefShortDate(latest.value.receivedAt, locale.value),
		},
		props.messageCount
	);
});
const replyLabel = computed(() =>
	openForYou.value > 1
		? t('components.brief.actions.replyAll', { count: openForYou.value })
		: t('components.brief.actions.reply')
);
</script>

<template>
	<div class="space-y-3" data-testid="thread-overview">
		<p
			v-if="brief && (openForYou > 0 || waiting > 0)"
			class="flex flex-wrap items-center gap-2 text-xs text-text-tertiary"
		>
			<span v-if="openForYou > 0" class="rounded-full bg-brand-soft px-2 font-medium text-brand">{{
				t('components.brief.meta.forYou', { count: openForYou }, openForYou)
			}}</span>
			<span v-if="waiting > 0" class="rounded-full bg-info-subtle px-2 font-medium text-info">{{
				t('components.brief.meta.waiting', { count: waiting }, waiting)
			}}</span>
		</p>

		<ThreadBrief
			:brief="brief"
			:source-of="state.sourceOf"
			:is-signed="state.isSigned.value"
			:latest-note="latestNote"
			@react="state.react"
			@cite="state.openCite"
			@open-conversation="state.setView('conversation')"
		/>

		<button
			type="button"
			class="flex w-full items-center gap-2.5 rounded-lg border border-border-subtle bg-bg-elevated px-3.5 py-2.5 text-left text-sm text-text-secondary hover:bg-bg-surface"
			data-testid="overview-open-conversation"
			@click="state.setView('conversation')"
		>
			<span>{{ t('components.brief.conversation.read') }}</span>
			<b v-if="span" class="font-medium text-text-primary">{{ span }}</b>
			<span class="ml-auto font-medium text-brand">{{
				t('components.brief.conversation.open')
			}}</span>
		</button>

		<div
			class="flex flex-wrap items-center gap-2 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-6 max-sm:border-t max-sm:border-border-subtle max-sm:bg-bg-base max-sm:px-6 max-sm:py-3"
			data-testid="overview-actions"
		>
			<UiButton class="max-sm:flex-1" @click="emit('action', 'reply')">{{ replyLabel }}</UiButton>
			<UiButton variant="secondary" @click="emit('action', 'archive')">{{
				t('components.brief.actions.archive')
			}}</UiButton>
			<UiButton variant="ghost" class="max-sm:hidden" @click="emit('action', 'snooze')">{{
				t('components.brief.actions.snooze')
			}}</UiButton>
			<UiButton
				v-if="aiEnabled && latest"
				variant="ghost"
				class="max-sm:hidden"
				:aria-expanded="asking"
				data-testid="overview-ask"
				@click="asking = !asking"
				>{{ t('components.brief.actions.ask') }}</UiButton
			>
		</div>

		<PostboxAiStrip
			v-if="asking && latest"
			:message-id="latest._id"
			:warrants-summary="false"
			ask-only
			@close="asking = false"
		/>
	</div>
</template>
