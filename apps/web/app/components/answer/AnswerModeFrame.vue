<script setup lang="ts">
/**
 * Answer mode's frame: one reply, the whole screen (plan §02, §04).
 *
 * A top bar ("← Inbox" with its Esc hint, the subject and message count, and
 * three slots the page fills: who the reply goes out as, queue navigation, a ⋯
 * menu) over a body of two columns, the conversation and the composer.
 *
 * The columns are laid out by width alone, so there is no breakpoint state to
 * keep in sync:
 *   - from 1100px: side by side, conversation ~52%, composer ~48%;
 *   - 768–1100px: stacked, the conversation scrolls and the composer is a
 *     sheet along the bottom;
 *   - below 768px: two tabs, Conversation and Reply, one column each.
 *
 * Both columns stay mounted in every layout: switching a tab on a phone must
 * not throw away the draft being typed.
 */
const props = defineProps<{
	/** Where "←" goes, spelled as a place ("Inbox", "Answer queue"). */
	backLabel: string;
	subject: string;
	/** Messages in the conversation; omitted while it loads. */
	messageCount?: number;
	/** A short line after the count: the correspondent. */
	counterpart?: string;
}>();

const emit = defineEmits<{ back: [] }>();

/** The phone layout's open tab. The page switches it (Cmd/Ctrl+J opens Reply). */
const tab = defineModel<'conversation' | 'reply'>('tab', { default: 'conversation' });

const { t } = useI18n();

const metaLine = computed(() => {
	const parts: string[] = [];
	if (props.messageCount !== undefined) {
		parts.push(
			t('components.answer.mode.messageCount', { count: props.messageCount }, props.messageCount)
		);
	}
	if (props.counterpart) parts.push(props.counterpart);
	return parts.join(' · ');
});

const conversationPanelId = useId();
const replyPanelId = useId();
</script>

<template>
	<div
		class="flex h-[calc(100dvh-var(--titlebar-h,0px))] flex-col bg-bg-base"
		data-testid="answer-mode"
	>
		<header
			class="flex items-center gap-3 border-b border-border-subtle bg-bg-elevated px-3 py-2 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] md:px-4"
		>
			<button
				type="button"
				class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:aria-label="t('components.answer.mode.back', { page: backLabel })"
				data-testid="answer-back"
				@click="emit('back')"
			>
				<Icon name="lucide:arrow-left" class="size-4" />
				<span class="max-md:hidden">{{ backLabel }}</span>
				<kbd class="font-mono text-2xs text-text-tertiary max-md:hidden">Esc</kbd>
			</button>
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-sm font-medium text-text-primary" data-testid="answer-subject">
					{{ subject || t('components.shell.noSubject') }}
				</h1>
				<p v-if="metaLine" class="truncate text-xs text-text-tertiary">{{ metaLine }}</p>
			</div>
			<div class="hidden min-w-0 lg:flex">
				<slot name="identity" />
			</div>
			<slot name="queue" />
			<slot name="menu" />
		</header>

		<div
			role="tablist"
			:aria-label="t('components.answer.mode.tabsLabel')"
			class="flex border-b border-border-subtle bg-bg-elevated md:hidden"
		>
			<button
				v-for="item in ['conversation', 'reply'] as const"
				:key="item"
				type="button"
				role="tab"
				:aria-selected="tab === item"
				:aria-controls="item === 'conversation' ? conversationPanelId : replyPanelId"
				class="flex-1 border-b-2 px-3 py-2.5 text-sm font-medium"
				:class="
					tab === item
						? 'border-brand text-text-primary'
						: 'border-transparent text-text-tertiary hover:text-text-primary'
				"
				:data-testid="`answer-tab-${item}`"
				@click="tab = item"
			>
				{{ t(`components.answer.mode.tabs.${item}`) }}
			</button>
		</div>

		<div class="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
			<section
				:id="conversationPanelId"
				class="min-h-0 flex-1 overflow-y-auto min-[1100px]:basis-[52%]"
				:class="{ 'max-md:hidden': tab !== 'conversation' }"
				:aria-label="t('components.answer.mode.tabs.conversation')"
				data-testid="answer-conversation-column"
			>
				<slot name="conversation" />
			</section>
			<section
				:id="replyPanelId"
				class="flex min-h-0 flex-col border-border-subtle bg-bg-elevated md:h-[min(60dvh,34rem)] md:shrink-0 md:border-t min-[1100px]:h-auto min-[1100px]:shrink min-[1100px]:basis-[48%] min-[1100px]:border-t-0 min-[1100px]:border-l"
				:class="tab === 'reply' ? 'max-md:flex-1' : 'max-md:hidden'"
				:aria-label="t('components.answer.mode.tabs.reply')"
				data-testid="answer-composer-column"
			>
				<slot name="composer" />
			</section>
		</div>
	</div>
</template>
