<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Search — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
const router = useRouter();

const query = ref(String(route.query['q'] ?? ''));
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { parsed, results, isLoading } = usePostboxSearch(mailboxId, query);
const chips = computed(() => describeChips(parsed.value));

// In-place preview: clicking a result selects it here rather than navigating
// into the folder view (which would eject the user out of search and mislabel
// the folder, since every hit shares one results list across folders).
const activeMessageId = ref<string | null>(null);

// Drop the selection when it falls out of the current result set (e.g. the
// query changed) so the reader doesn't show a stale message.
watch(results, (rows) => {
	if (activeMessageId.value && !rows.some((m) => m._id === activeMessageId.value)) {
		activeMessageId.value = null;
	}
});

const { data: activeMessage } = useConvexQuery(api.mail.mailbox.getMessage, () =>
	activeMessageId.value
		? { messageId: activeMessageId.value as Id<'mailMessages'> }
		: 'skip'
);

watch(query, (q) => {
	router.replace({ query: { ...route.query, q } });
});

function removeChip(key: string) {
	const re = new RegExp(`(?:^|\\s)${key}:[^\\s]+`, 'g');
	query.value = query.value.replace(re, '').trim();
}
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
		<div class="flex w-full">
			<aside class="w-[420px] border-r border-border-subtle flex flex-col bg-bg-surface">
				<header class="border-b border-border-subtle px-4 py-3 space-y-2">
					<PostboxSearchBar v-model="query" />
					<div v-if="chips.length > 0" class="flex flex-wrap gap-1">
						<button
							v-for="chip in chips"
							:key="chip.label"
							type="button"
							class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-bg-elevated text-text-secondary hover:text-text-primary"
							@click="removeChip(chip.key)"
						>
							{{ chip.label }}
							<Icon name="lucide:x" class="w-3 h-3" />
						</button>
					</div>
				</header>
				<div class="flex-1 overflow-auto">
					<div v-if="!query.trim()" class="p-6 text-sm text-text-tertiary">
						Try operators like <code>from:sara</code>, <code>has:attachment</code>,
						<code>before:2024-01-01</code>, <code>label:work</code>, <code>is:unread</code>.
					</div>
					<div v-else-if="isLoading" class="p-6 flex justify-center">
						<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
					</div>
					<div v-else-if="results.length === 0" class="p-6 text-sm text-text-tertiary">
						No matches.
					</div>
					<PostboxThreadList
						v-else-if="mailboxId"
						:mailbox-id="mailboxId"
						:messages="results"
						:loading="false"
						folder-role="inbox"
						selectable
						:active-message-id="activeMessageId"
						@select="activeMessageId = $event"
					/>
				</div>
			</aside>
			<section class="flex-1 overflow-auto bg-bg-base">
				<PostboxThreadReader v-if="activeMessage" :message="activeMessage" />
				<div v-else class="h-full flex items-center justify-center">
					<div class="text-center">
						<Icon name="lucide:mail-open" class="w-12 h-12 mx-auto text-text-tertiary" />
						<p class="mt-4 text-text-secondary">Select a result</p>
					</div>
				</div>
			</section>
		</div>
		</PostboxMailboxGuard>
		<PostboxComposerStack />
	</div>
</template>
