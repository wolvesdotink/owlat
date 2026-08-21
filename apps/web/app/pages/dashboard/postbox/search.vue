<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.search.pageTitle') });

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

// Keyset-paginated results: "Load more" walks past the first page via the
// backend's opaque cursor instead of silently stopping at a cap.
const { parsed, results, isLoading, hasMore, loadMore } = usePostboxSearch(mailboxId, query);
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
	activeMessageId.value ? { messageId: activeMessageId.value as Id<'mailMessages'> } : 'skip'
);

watch(query, (q) => {
	router.replace({ query: { ...route.query, q } });
});

function removeChip(key: string) {
	const re = new RegExp(`(?:^|\\s)${key}:[^\\s]+`, 'g');
	query.value = query.value.replace(re, '').trim();
}

/** Drop every operator at once (guided empty state's "Clear all filters"). */
function clearAllChips() {
	query.value = parsed.value.text;
}
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div class="flex w-full">
				<!-- Below lg the results and the reader are a stacked drill-in: one at a
			     time, with a back button in the reader. -->
				<aside
					class="w-full lg:w-[420px] lg:flex-shrink-0 border-r border-border-subtle flex-col bg-bg-surface"
					:class="activeMessageId ? 'hidden lg:flex' : 'flex'"
				>
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
						<I18nT
							v-if="!query.trim()"
							keypath="dashboard.postbox.search.operatorHint"
							tag="div"
							scope="global"
							class="p-6 text-sm text-text-tertiary"
						>
							<template #from><code>from:sara</code></template>
							<template #hasAttachment><code>has:attachment</code></template>
							<template #before><code>before:2024-01-01</code></template>
							<template #label><code>label:work</code></template>
							<template #isUnread><code>is:unread</code></template>
						</I18nT>
						<PostboxThreadListSkeleton v-else-if="isLoading && results.length === 0" :rows="6" />
						<!-- Guided empty state: a zero-hit search offers one-click escapes —
					     drop an operator or clear them all — instead of a dead end. -->
						<PostboxEmptyState
							v-else-if="results.length === 0"
							icon="lucide:search-x"
							:title="t('dashboard.postbox.search.noResultsTitle')"
							:hint="t('dashboard.postbox.search.noResultsHint')"
						>
							<template #action>
								<div class="mt-3 flex flex-wrap items-center justify-center gap-1.5">
									<button
										v-for="chip in chips.slice(0, 2)"
										:key="chip.key"
										type="button"
										class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border-default bg-bg-surface text-xs text-text-secondary hover:text-text-primary hover:border-border-strong"
										@click="removeChip(chip.key)"
									>
										{{ t('dashboard.postbox.search.removeChip', { chip: chip.label }) }}
										<Icon name="lucide:x" class="w-3 h-3" />
									</button>
									<button
										v-if="chips.length > 2"
										type="button"
										class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-border-default text-xs text-text-secondary hover:text-text-primary"
										@click="clearAllChips"
									>
										{{ t('dashboard.postbox.search.clearAllFilters') }}
									</button>
								</div>
							</template>
						</PostboxEmptyState>
						<template v-else-if="mailboxId">
							<!-- Honest count line: the result set is real, not a silent cap.
						     "Load more" walks deeper via the backend's keyset cursor. -->
							<p class="px-4 pt-3 pb-1 text-xs text-text-tertiary" role="status">
								{{
									t('dashboard.postbox.search.resultCount', { count: results.length }, results.length)
								}}
								<template v-if="hasMore">
									{{ t('dashboard.postbox.search.moreBelow') }}</template
								>
							</p>
							<PostboxThreadList
								:mailbox-id="mailboxId"
								:messages="results"
								:loading="false"
								folder-role="inbox"
								selectable
								:active-message-id="activeMessageId"
								:has-more="hasMore"
								@select="activeMessageId = $event"
								@load-more="loadMore"
							/>
						</template>
					</div>
				</aside>
				<section
					class="flex-1 min-w-0 overflow-auto bg-bg-base"
					:class="activeMessageId ? 'block' : 'hidden lg:block'"
				>
					<!-- The bar carries no vertical padding of its own: the button owns it,
					     so the whole 44px height is a touch target and not just its
					     middle third. -->
					<div
						v-if="activeMessageId"
						class="lg:hidden sticky top-0 z-10 flex items-center border-b border-border-subtle bg-bg-base px-2"
					>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none rounded px-2 py-3"
							@click="activeMessageId = null"
						>
							<Icon name="lucide:arrow-left" class="w-4 h-4" />
							{{ t('dashboard.postbox.search.backToResults') }}
						</button>
					</div>
					<PostboxThreadReader v-if="activeMessage" :message="activeMessage" />
					<div v-else class="h-full flex items-center justify-center">
						<div class="text-center">
							<Icon name="lucide:mail-open" class="w-12 h-12 mx-auto text-text-tertiary" />
							<p class="mt-4 text-text-secondary">
								{{ t('dashboard.postbox.search.selectResult') }}
							</p>
						</div>
					</div>
				</section>
			</div>
		</PostboxMailboxGuard>
		<PostboxComposerStack />
		<PostboxShortcutHelp />
	</div>
</template>
