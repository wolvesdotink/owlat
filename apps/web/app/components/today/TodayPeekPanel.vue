<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { TodaySource } from '~/utils/todayDigest';
import { parsePeekKey, threadHref } from '~/utils/todayPeek';
import { isEditableTarget } from '~/utils/postboxShortcuts';

/**
 * The email behind a Today phrase, in a panel over the page. Today stays put
 * underneath (Esc or "Back to Today" closes the panel); ↑/↓ step through the
 * other emails the same sentence summarised. Opening a Postbox email marks it
 * read; the line itself stays on Today until you mark it done or mark
 * everything as seen, so the page never reshuffles under you.
 */
const props = defineProps<{ sources: TodaySource[] }>();
const emit = defineEmits<{ close: []; step: [index: number]; done: [source: TodaySource] }>();

const { t } = useI18n();
const route = useRoute();
const { byId } = useInboxes();

const target = computed(() => parsePeekKey(route.query['peek']));
const index = computed(() => {
	const key = target.value;
	if (!key) return -1;
	return props.sources.findIndex((s) => s.kind === key.kind && s.id === key.id);
});
const { data: mailMessage, isLoading: mailLoading } = useConvexQuery(
	api.mail.mailbox.messages.getMessage,
	() =>
		target.value?.kind === 'mail' ? { messageId: target.value.id as Id<'mailMessages'> } : 'skip'
);

// A shared `?peek=` link (the morning brief email, a bookmark) arrives without
// the phrase's source list; a Postbox email can describe itself.
const source = computed<TodaySource | null>(() => {
	const listed = props.sources[index.value];
	if (listed) return listed;
	const m = mailMessage.value;
	if (target.value?.kind !== 'mail' || !m) return null;
	return {
		kind: 'mail',
		id: m._id,
		threadId: m.threadId,
		mailboxId: m.mailboxId,
		fromName: m.fromName ?? null,
		fromAddress: m.fromAddress,
		subject: m.subject,
		snippet: m.snippet,
		at: m.receivedAt,
	};
});
const teamThreadId = computed(() =>
	target.value?.kind === 'team' && source.value?.threadId
		? (source.value.threadId as Id<'conversationThreads'>)
		: null
);
const { data: teamThread, isLoading: teamLoading } = useConvexQuery(
	api.inbox.queries.getThread,
	() => (teamThreadId.value ? { threadId: teamThreadId.value } : 'skip')
);
const teamMessage = computed(
	() => teamThread.value?.messages.find((m) => m._id === target.value?.id) ?? null
);

const isLoading = computed(() =>
	target.value?.kind === 'mail' ? mailLoading.value : teamLoading.value
);
const view = computed(() => {
	if (target.value?.kind === 'mail' && mailMessage.value) {
		const m = mailMessage.value;
		return {
			subject: m.subject,
			from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
			to: m.toAddresses.join(', '),
			at: m.receivedAt,
			body: m.textBodyInline?.trim() || m.snippet,
			attachments: m.attachments.map((a) => a.filename),
		};
	}
	if (target.value?.kind === 'team' && teamMessage.value) {
		const m = teamMessage.value;
		return {
			subject: m.subject,
			from: m.from,
			to: m.to,
			at: m.receivedAt,
			body: m.textBody?.trim() || '',
			attachments: [] as string[],
		};
	}
	return null;
});

const inbox = computed(() =>
	source.value?.mailboxId
		? (byId.value.get(source.value.mailboxId as Id<'mailboxes'>) ?? null)
		: null
);

// Reading it here counts as reading it: mark a Postbox email read on open.
const { run: markRead } = useBackendOperation(api.mail.messageActions.setFlags, {
	label: () => t('components.today.peek.markReadOperation'),
});
watch(
	() => mailMessage.value?._id,
	(id) => {
		if (id && mailMessage.value && !mailMessage.value.flagSeen) {
			void markRead({ messageIds: [id], seen: true });
		}
	}
);

function step(delta: number) {
	const next = index.value + delta;
	if (next >= 0 && next < props.sources.length) emit('step', next);
}
function onKeydown(event: KeyboardEvent) {
	if (!target.value || isEditableTarget(event.target)) return;
	if (event.key === 'Escape') {
		event.preventDefault();
		emit('close');
	} else if (event.key === 'ArrowDown' || event.key === 'j') {
		event.preventDefault();
		step(1);
	} else if (event.key === 'ArrowUp' || event.key === 'k') {
		event.preventDefault();
		step(-1);
	}
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const panelRef = ref<HTMLElement | null>(null);
watch(target, async (value, previous) => {
	if (value && !previous) {
		await nextTick();
		panelRef.value?.focus();
	}
});
</script>

<template>
	<Transition
		enter-active-class="transition duration-(--motion-moderate) ease-(--ease-spring)"
		enter-from-class="translate-x-4 opacity-0"
		leave-active-class="transition duration-(--motion-moderate-exit)"
		leave-to-class="translate-x-4 opacity-0"
	>
		<aside
			v-if="target"
			ref="panelRef"
			tabindex="-1"
			role="dialog"
			:aria-label="view?.subject || t('components.today.peek.label')"
			class="fixed bottom-0 right-0 top-[calc(var(--titlebar-h,0px)+4rem)] z-30 flex w-full max-w-md flex-col border-l border-border-subtle bg-bg-elevated shadow-(--shadow-6) outline-none"
		>
			<header
				class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5 text-xs text-text-tertiary"
			>
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-bg-surface hover:text-text-primary"
					@click="emit('close')"
				>
					<Icon name="lucide:arrow-left" class="size-3.5" />
					{{ t('components.today.peek.back') }}
					<kbd class="font-mono text-2xs">Esc</kbd>
				</button>
				<span v-if="sources.length > 1" class="ml-auto flex items-center gap-1">
					{{ t('components.today.peek.position', { index: index + 1, total: sources.length }) }}
					<button
						type="button"
						class="rounded p-1 hover:bg-bg-surface disabled:opacity-40"
						:disabled="index <= 0"
						:aria-label="t('components.today.peek.previous')"
						@click="step(-1)"
					>
						<Icon name="lucide:chevron-up" class="size-3.5" />
					</button>
					<button
						type="button"
						class="rounded p-1 hover:bg-bg-surface disabled:opacity-40"
						:disabled="index >= sources.length - 1"
						:aria-label="t('components.today.peek.next')"
						@click="step(1)"
					>
						<Icon name="lucide:chevron-down" class="size-3.5" />
					</button>
				</span>
			</header>

			<div v-if="isLoading && !view" class="space-y-3 p-5">
				<UiSkeleton class="h-5 w-3/4" />
				<UiSkeleton class="h-3 w-1/2" />
				<UiSkeleton class="h-24 w-full" />
			</div>
			<div v-else-if="!view" class="p-5 text-sm text-text-secondary">
				{{ t('components.today.peek.gone') }}
			</div>
			<div v-else class="min-h-0 flex-1 overflow-y-auto p-5">
				<div class="flex items-start gap-2">
					<InboxChip v-if="inbox" :name="inbox.name" :slot="inbox.slot" class="mt-0.5" />
					<span
						v-else-if="source?.kind === 'team'"
						class="mt-0.5 inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
					>
						<Icon name="lucide:bot" class="size-3" />{{ t('components.shell.teamInbox') }}
					</span>
					<h2 class="text-base font-medium leading-snug text-text-primary">
						{{ view.subject || t('components.shell.noSubject') }}
					</h2>
				</div>
				<p class="mt-2 text-xs text-text-tertiary">
					{{ view.from }} · {{ formatCompactRelativeTime(view.at) }}
				</p>
				<p class="mt-4 whitespace-pre-line text-sm leading-relaxed text-text-secondary">
					{{ view.body }}
				</p>
				<div v-if="view.attachments.length > 0" class="mt-4 flex flex-wrap gap-1.5">
					<span
						v-for="name in view.attachments.slice(0, 3)"
						:key="name"
						class="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-2xs text-text-secondary"
					>
						<Icon name="lucide:paperclip" class="size-3" />{{ name }}
					</span>
					<span v-if="view.attachments.length > 3" class="text-2xs text-text-tertiary">
						+{{ view.attachments.length - 3 }}
					</span>
				</div>
			</div>

			<footer
				v-if="view && source"
				class="flex items-center gap-2 border-t border-border-subtle px-5 py-3"
			>
				<UiButton size="sm" @click="emit('done', source)">
					{{ t('components.today.peek.done') }}
				</UiButton>
				<slot name="actions" :source="source" />
				<UiButton size="sm" variant="secondary" :to="threadHref(source)" class="ml-auto">
					{{ t('components.today.peek.openThread') }}
				</UiButton>
			</footer>
		</aside>
	</Transition>
</template>
