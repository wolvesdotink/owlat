<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { formatDate } from '~/utils/formatters';
import { useFollowLatest } from '~/composables/useFollowLatest';

const { t } = useI18n();

useHead({ title: () => t('dashboard.assistant.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'ai.assistant',
});

const {
	activeId,
	conversations,
	conversationsLoading,
	conversationsError,
	refetchConversations,
	messages,
	messagesError,
	refetchMessages,
	activeConversation,
	streaming,
	selectConversation,
	newConversation,
	send,
	stop,
	rename,
	remove,
} = useAssistant();

// The composer owns the question until the backend accepts it, so example
// prompts go through it too (a failed one stays there with Retry), and it is
// where focus lands after the pill or the conversation drawer.
const composerRef = ref<{
	sendText: (text: string) => Promise<void>;
	focus: () => void;
} | null>(null);

// Below md the conversation rail is an off-canvas drawer (see UiRailDrawer). It
// used to be `hidden md:flex`, which on a phone removed the conversation list
// and — since it lives in the rail's header — the only "New chat" button.
const railOpen = ref(false);

const startConversation = () => {
	railOpen.value = false;
	newConversation();
};

const openConversation = (id: Id<'aiConversations'>) => {
	railOpen.value = false;
	selectConversation(id);
};

// Closing the phone drawer (a pick, New chat, the scrim, Escape) hands focus to
// the question field rather than dropping it on the page.
watch(railOpen, (open, wasOpen) => {
	if (wasOpen && !open) nextTick(() => composerRef.value?.focus());
});

// Follow the stream only while the reader is at the end (#1050): scrolling up
// to reread something is respected, and new content below raises the "Jump to
// latest" pill instead of pulling the view down.
const scrollRef = ref<HTMLElement | null>(null);
const { following, hasNewBelow, onScroll, onContent, jumpToLatest } = useFollowLatest(scrollRef);
watch(() => {
	const last = messages.value.at(-1);
	return [
		messages.value.length,
		last?.text.length,
		last?.status,
		last?.toolCalls.length,
		last?.toolCalls.map((c) => c.status).join(),
	];
}, onContent);
// A conversation opens at its latest message.
watch(activeId, () => void jumpToLatest({ smooth: false }));

const onJumpToLatest = () => {
	void jumpToLatest();
	composerRef.value?.focus();
};

// The member just asked for this answer, so their own send always goes to the
// end and follows it, wherever they had scrolled to.
const sendQuestion = (text: string) => {
	void jumpToLatest();
	return send(text);
};

const examplePrompts = computed(() => [
	t('dashboard.assistant.index.examplePrompts.performance'),
	t('dashboard.assistant.index.examplePrompts.engagedContacts'),
	t('dashboard.assistant.index.examplePrompts.reEngagement'),
]);

const onExample = (prompt: string) => {
	void composerRef.value?.sendText(prompt);
};

// Deleting a chat is irreversible, so confirm before removing it.
const pendingDelete = ref<{ _id: Id<'aiConversations'>; title: string } | null>(null);
const isDeleting = ref(false);

const confirmDelete = async () => {
	if (!pendingDelete.value) return;
	isDeleting.value = true;
	try {
		await remove(pendingDelete.value._id);
		pendingDelete.value = null;
	} finally {
		isDeleting.value = false;
	}
};

// Which conversation's More actions menu is open, if any.
const actionsOpenId = ref<Id<'aiConversations'> | null>(null);

// Inline rename of a conversation title in the list.
const editingId = ref<Id<'aiConversations'> | null>(null);
const editingTitle = ref('');

const startRename = (id: Id<'aiConversations'>, currentTitle: string) => {
	editingId.value = id;
	editingTitle.value = currentTitle;
	nextTick(() => {
		const el = document.getElementById(`conversation-rename-${id}`) as HTMLInputElement | null;
		el?.focus();
		el?.select();
	});
};

// Enter and Escape hand focus back to the row's More actions button, where the
// rename started; a blur (the member clicked elsewhere) leaves focus alone.
const focusRowActions = (id: Id<'aiConversations'>) =>
	nextTick(() => document.getElementById(`conversation-actions-${id}`)?.focus());

const commitRename = async (options: { restoreFocus?: boolean } = {}) => {
	const id = editingId.value;
	if (!id) return;
	const title = editingTitle.value.trim();
	const current = conversations.value.find((c) => c._id === id);
	editingId.value = null;
	if (options.restoreFocus) void focusRowActions(id);
	if (title && current && title !== current.title) await rename(id, title);
};

const cancelRename = () => {
	const id = editingId.value;
	editingId.value = null;
	if (id) void focusRowActions(id);
};
</script>

<template>
	<!-- Below lg the chrome around this pane is 4rem of header bar, 2.25rem of
	     breadcrumb strip and the 4rem the tab bar reserves at the bottom of
	     #main-content, plus both safe areas — subtract all of it, or the page
	     itself scrolls and the composer loads under the fold. -->
	<div
		class="flex h-[calc(100dvh-10.25rem-1px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] lg:h-[calc(100vh-4rem-3rem)]"
	>
		<!-- Conversation list: a column at md, an off-canvas drawer below it -->
		<UiRailDrawer
			id="assistant-rail"
			v-model:open="railOpen"
			:navigation-title="t('shell.dashboard.assistantNavigation')"
		>
			<aside class="flex flex-1 min-w-0 flex-col border-r border-border-subtle bg-bg-elevated">
				<div class="p-3">
					<UiButton full-width class="gap-2" @click="startConversation">
						<Icon name="lucide:plus" class="w-4 h-4" />
						{{ t('dashboard.assistant.index.newChat') }}
					</UiButton>
				</div>
				<div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
					<div v-if="conversationsLoading" class="px-3 py-2 text-sm text-text-tertiary">
						{{ t('common.loading') }}
					</div>
					<UiQueryBoundary
						v-else-if="conversationsError"
						:error="conversationsError"
						@retry="refetchConversations"
					/>
					<p v-else-if="conversations.length === 0" class="px-3 py-2 text-sm text-text-tertiary">
						{{ t('dashboard.assistant.index.noConversations') }}
					</p>
					<!-- Selection and the row's actions are siblings, not nested (#1051):
					     the row is a real button the keyboard can reach, and Rename /
					     Delete sit behind one More actions button beside it. -->
					<div
						v-for="c in conversations"
						:key="c._id"
						class="group flex items-center rounded-lg text-sm transition-colors"
						:class="
							c._id === activeId
								? 'bg-bg-surface text-text-primary'
								: 'text-text-secondary hover:bg-bg-surface/60'
						"
					>
						<div
							v-if="editingId === c._id"
							class="flex flex-1 min-w-0 items-center gap-2 px-3 py-1.5"
						>
							<Icon name="lucide:message-square" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
							<input
								:id="`conversation-rename-${c._id}`"
								v-model="editingTitle"
								type="text"
								maxlength="120"
								class="input input-sm flex-1 min-w-0"
								:aria-label="t('dashboard.assistant.index.renameConversation')"
								@blur="commitRename()"
								@keyup.enter="commitRename({ restoreFocus: true })"
								@keyup.escape="cancelRename"
							/>
						</div>
						<template v-else>
							<button
								type="button"
								class="flex flex-1 min-w-0 items-center gap-2 pl-3 pr-1 py-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								:aria-current="c._id === activeId ? 'page' : undefined"
								:title="c.title"
								data-testid="assistant-conversation"
								@click="openConversation(c._id)"
							>
								<Icon
									name="lucide:message-square"
									class="w-4 h-4 flex-shrink-0 text-text-tertiary"
								/>
								<span class="flex-1 truncate">{{ c.title }}</span>
								<span class="text-2xs text-text-tertiary flex-shrink-0">{{
									formatDate(c.lastMessageAt, 'short')
								}}</span>
							</button>
							<!-- Hidden until hover or focus on a pointer device; always shown
							     where there is no hover (touch), and while its menu is open. -->
							<UiDropdownMenu
								:open="actionsOpenId === c._id"
								position="right"
								class="flex-shrink-0 mr-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
								:class="actionsOpenId === c._id && 'opacity-100'"
								@update:open="(v: boolean) => (actionsOpenId = v ? c._id : null)"
							>
								<template #trigger>
									<button
										:id="`conversation-actions-${c._id}`"
										type="button"
										class="w-8 h-8 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:title="t('dashboard.assistant.index.moreActions')"
										:aria-label="t('dashboard.assistant.index.moreActionsFor', { title: c.title })"
										data-testid="assistant-conversation-actions"
									>
										<Icon name="lucide:ellipsis" class="w-4 h-4" />
									</button>
								</template>
								<UiDropdownMenuItem icon="lucide:pencil" @click="startRename(c._id, c.title)">
									{{ t('dashboard.assistant.index.renameConversation') }}
								</UiDropdownMenuItem>
								<UiDropdownMenuItem
									icon="lucide:trash-2"
									danger
									@click="pendingDelete = { _id: c._id, title: c.title }"
								>
									{{ t('dashboard.assistant.index.deleteConversation') }}
								</UiDropdownMenuItem>
							</UiDropdownMenu>
						</template>
					</div>
				</div>
			</aside>
		</UiRailDrawer>

		<!-- Main thread -->
		<section class="flex-1 flex flex-col min-w-0">
			<!-- Below md the rail is off-canvas, so the thread carries its own way
			     back to the conversation list and its own new-chat verb. The handle
			     is named, like chat's: a lone icon in an otherwise empty strip reads
			     as stray chrome and says nothing about what it opens. 44px targets,
			     which is also the bar's height; the negative inline margins keep
			     them optically aligned with the content below. -->
			<div class="md:hidden px-3 border-b border-border-subtle flex items-center justify-between">
				<button
					type="button"
					class="-ml-2 h-11 flex items-center gap-1.5 px-2 rounded text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
					aria-controls="assistant-rail"
					:aria-expanded="railOpen"
					@click="railOpen = true"
				>
					<Icon name="lucide:panel-left" class="w-4 h-4" />
					<span class="text-sm">{{ t('dashboard.assistant.index.openConversations') }}</span>
				</button>
				<button
					type="button"
					class="-mr-2 w-11 h-11 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
					:aria-label="t('dashboard.assistant.index.newChat')"
					@click="startConversation"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</button>
			</div>

			<header
				v-if="activeConversation"
				class="border-b border-border-subtle px-4 py-2.5 flex items-center gap-2"
			>
				<Icon name="lucide:sparkles" class="w-4 h-4 text-brand flex-shrink-0" />
				<h1 class="text-sm font-semibold text-text-primary truncate">
					{{ activeConversation.title }}
				</h1>
			</header>

			<div class="relative flex-1 min-h-0 flex flex-col">
				<div ref="scrollRef" class="flex-1 overflow-y-auto px-4 py-4" @scroll.passive="onScroll">
					<!-- A conversation that failed to load is not a new one (#721). -->
					<UiQueryBoundary
						v-if="activeId && messagesError"
						:error="messagesError"
						@retry="refetchMessages"
					/>
					<!-- Welcome / empty state -->
					<div
						v-else-if="!activeId || messages.length === 0"
						class="h-full flex flex-col items-center justify-center text-center px-6"
					>
						<div
							class="w-16 h-16 rounded-full bg-brand-subtle text-brand flex items-center justify-center mb-4"
						>
							<Icon name="lucide:sparkles" class="w-8 h-8" />
						</div>
						<h2 class="text-lg font-medium text-text-primary">
							{{ t('dashboard.assistant.index.welcomeTitle') }}
						</h2>
						<p class="text-sm text-text-secondary mt-1 max-w-md">
							{{ t('dashboard.assistant.index.welcomeBody') }}
						</p>
						<div class="mt-6 flex flex-col gap-2 w-full max-w-md">
							<button
								v-for="prompt in examplePrompts"
								:key="prompt"
								class="text-left text-sm px-4 py-2.5 rounded-xl bg-surface-1 shadow-surface-1 text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								@click="onExample(prompt)"
							>
								{{ prompt }}
							</button>
						</div>
					</div>

					<!-- Conversation -->
					<div v-else class="max-w-3xl mx-auto space-y-5">
						<AssistantMessage v-for="m in messages" :key="m._id" :message="m" />
					</div>
				</div>

				<!-- New content arrived below a reader who scrolled up to reread. -->
				<div
					v-if="hasNewBelow && !following"
					class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"
				>
					<UiButton
						variant="secondary"
						size="sm"
						class="pointer-events-auto gap-1.5 rounded-full shadow-md"
						data-testid="assistant-jump-latest"
						@click="onJumpToLatest"
					>
						{{ t('dashboard.assistant.index.jumpToLatest') }}
						<Icon name="lucide:arrow-down" class="w-3.5 h-3.5" />
					</UiButton>
				</div>
			</div>

			<AssistantComposer
				ref="composerRef"
				:send="sendQuestion"
				:streaming="streaming"
				@stop="stop"
			/>
		</section>

		<!-- Delete confirmation — a removed chat and its messages cannot be recovered -->
		<UiConfirmationDialog
			:open="!!pendingDelete"
			variant="danger"
			:title="t('dashboard.assistant.index.deleteDialog.title')"
			:description="
				t('dashboard.assistant.index.deleteDialog.description', {
					title: pendingDelete?.title ?? '',
				})
			"
			:confirm-text="t('dashboard.assistant.index.deleteDialog.confirm')"
			:is-loading="isDeleting"
			@update:open="
				(v: boolean) => {
					if (!v) pendingDelete = null;
				}
			"
			@confirm="confirmDelete"
		/>
	</div>
</template>
