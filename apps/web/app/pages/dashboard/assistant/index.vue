<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Assistant — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'ai.assistant',
});

const {
	activeId,
	conversations,
	conversationsLoading,
	messages,
	activeConversation,
	streaming,
	selectConversation,
	newConversation,
	send,
	stop,
	rename,
	remove,
} = useAssistant();

const scrollRef = ref<HTMLElement | null>(null);
const scrollToBottom = () => {
	nextTick(() => {
		if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
	});
};
// Follow the stream: re-scroll as the last turn grows or a turn is added.
watch(
	() => [messages.value.length, messages.value.at(-1)?.text.length, messages.value.at(-1)?.status],
	scrollToBottom
);
watch(activeId, scrollToBottom);

const examplePrompts = [
	'Summarize the performance of our most recent campaign.',
	'What do we know about our most engaged contacts?',
	'Draft a friendly re-engagement email for inactive subscribers.',
];

const onExample = (prompt: string) => {
	void send(prompt);
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

const commitRename = async () => {
	const id = editingId.value;
	if (!id) return;
	const title = editingTitle.value.trim();
	const current = conversations.value.find((c) => c._id === id);
	editingId.value = null;
	if (title && current && title !== current.title) await rename(id, title);
};

const cancelRename = () => {
	editingId.value = null;
};

const formatDate = (ts: number) =>
	new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem-3rem)]">
		<!-- Conversation list -->
		<aside class="hidden md:flex w-72 flex-shrink-0 flex-col border-r border-border-subtle">
			<div class="p-3">
				<button class="btn btn-primary w-full gap-2" @click="newConversation">
					<Icon name="lucide:plus" class="w-4 h-4" />
					New chat
				</button>
			</div>
			<div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
				<div v-if="conversationsLoading" class="px-3 py-2 text-sm text-text-tertiary">Loading…</div>
				<p v-else-if="conversations.length === 0" class="px-3 py-2 text-sm text-text-tertiary">
					No conversations yet.
				</p>
				<div
					v-for="c in conversations"
					:key="c._id"
					class="group w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer"
					:class="
						c._id === activeId
							? 'bg-bg-surface text-text-primary'
							: 'text-text-secondary hover:bg-bg-surface/60'
					"
					@click="selectConversation(c._id)"
				>
					<Icon name="lucide:message-square" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					<input
						v-if="editingId === c._id"
						:id="`conversation-rename-${c._id}`"
						v-model="editingTitle"
						type="text"
						maxlength="120"
						class="flex-1 min-w-0 bg-transparent outline-none border-b border-border-subtle"
						@click.stop
						@blur="commitRename"
						@keyup.enter="commitRename"
						@keyup.escape="cancelRename"
					/>
					<template v-else>
						<span class="flex-1 truncate">{{ c.title }}</span>
						<span class="text-[11px] text-text-tertiary flex-shrink-0">{{
							formatDate(c.lastMessageAt)
						}}</span>
						<button
							class="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text-primary transition-opacity flex-shrink-0"
							title="Rename conversation"
							aria-label="Rename conversation"
							@click.stop="startRename(c._id, c.title)"
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
						</button>
						<button
							class="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-error transition-opacity flex-shrink-0"
							title="Delete conversation"
							aria-label="Delete conversation"
							@click.stop="pendingDelete = { _id: c._id, title: c.title }"
						>
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
						</button>
					</template>
				</div>
			</div>
		</aside>

		<!-- Main thread -->
		<section class="flex-1 flex flex-col min-w-0">
			<header
				v-if="activeConversation"
				class="border-b border-border-subtle px-4 py-2.5 flex items-center gap-2"
			>
				<Icon name="lucide:sparkles" class="w-4 h-4 text-brand flex-shrink-0" />
				<h1 class="text-sm font-semibold text-text-primary truncate">
					{{ activeConversation.title }}
				</h1>
			</header>

			<div ref="scrollRef" class="flex-1 overflow-y-auto px-4 py-4">
				<!-- Welcome / empty state -->
				<div
					v-if="!activeId || messages.length === 0"
					class="h-full flex flex-col items-center justify-center text-center px-6"
				>
					<div
						class="w-16 h-16 rounded-full bg-brand-subtle text-brand flex items-center justify-center mb-4"
					>
						<Icon name="lucide:sparkles" class="w-8 h-8" />
					</div>
					<h2 class="text-lg font-medium text-text-primary">How can I help?</h2>
					<p class="text-sm text-text-secondary mt-1 max-w-md">
						Ask about your contacts, campaigns, knowledge, and files — or have me draft an email or
						campaign copy. I can search your workspace to ground my answers.
					</p>
					<div class="mt-6 flex flex-col gap-2 w-full max-w-md">
						<button
							v-for="prompt in examplePrompts"
							:key="prompt"
							class="text-left text-sm px-4 py-2.5 rounded-xl border border-border-subtle text-text-secondary hover:bg-bg-surface hover:text-text-primary transition-colors"
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

			<AssistantComposer :streaming="streaming" @send="send" @stop="stop" />
		</section>

		<!-- Delete confirmation — a removed chat and its messages cannot be recovered -->
		<UiConfirmationDialog
			:open="!!pendingDelete"
			variant="danger"
			title="Delete chat"
			:description="`&quot;${pendingDelete?.title ?? ''}&quot; and all of its messages will be permanently deleted.`"
			confirm-text="Delete chat"
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
