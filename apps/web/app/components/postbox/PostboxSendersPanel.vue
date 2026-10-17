<script setup lang="ts">
/**
 * The Senders page's main card (SPEC §5, PLAN §8): who writes to you and what
 * Owlat does with their mail.
 *
 * Tabs: To review (the server's suggestions, bounded) / All / Digest /
 * Auto-archived / Unsubscribed (paginated by index). Each row's control sets
 * the sender's status as one undoable operation; Unsubscribe also asks the
 * sender to stop. "Apply N suggestions" confirms the list in a dialog and
 * applies it as one operation.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	APPLY_SUGGESTIONS_MAX,
	isSenderTab,
	senderName,
	SENDER_TABS,
	type PostboxSenderRow,
	type PostboxSenderStatus,
	type SenderTab,
} from '~/utils/postboxSenders';

const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { showToast } = useToast();
const actions = usePostboxSenderActions();

const tab = computed<SenderTab>({
	get: () => {
		const requested = route.query['tab'];
		return isSenderTab(requested) ? requested : 'review';
	},
	set: (value) => void router.replace({ query: { ...route.query, tab: value } }),
});

const review = useConvexQuery(api.mail.senders.page.review, () => ({ mailboxId: props.mailboxId }));
const reviewTotal = computed(() => review.data.value?.total ?? 0);

const listTab = computed(() => (tab.value === 'review' ? null : tab.value));
const list = usePaginatedQuery(
	api.mail.senders.page.list,
	() => (listTab.value === null ? 'skip' : { mailboxId: props.mailboxId, tab: listTab.value }),
	{ initialNumItems: 50 }
);

const tabs = computed(() =>
	SENDER_TABS.map((value) => ({
		value,
		label: t(`postbox.senders.tabs.${value}`),
		...(value === 'review' ? { count: reviewTotal.value } : {}),
	}))
);

const rows = computed<PostboxSenderRow[]>(() =>
	tab.value === 'review' ? (review.data.value?.rows ?? []) : list.results.value
);
const isLoading = computed(() =>
	tab.value === 'review' ? review.isLoading.value : list.status.value === 'LoadingFirstPage'
);
const error = computed(() => (tab.value === 'review' ? review.error.value : list.error.value));
function retry() {
	if (tab.value === 'review') review.refetch();
	else list.refetch();
}

function targetOf(row: PostboxSenderRow) {
	return { mailboxId: props.mailboxId, senderDigest: row.senderDigest };
}

async function onSetStatus(row: PostboxSenderRow, status: PostboxSenderStatus) {
	const name = senderName(row);
	if (status === 'unsubscribed') {
		await actions.unsubscribe(targetOf(row), { mailboxId: props.mailboxId, name });
		return;
	}
	await actions.setStatus(targetOf(row), status, name);
}

// ── Apply suggestions ────────────────────────────────────────────────────
const suggestions = computed(() =>
	(review.data.value?.rows ?? []).filter((row) => row.suggestion).slice(0, APPLY_SUGGESTIONS_MAX)
);
const isDialogOpen = ref(false);
const applyOp = useBackendOperation(api.mail.senders.suggestions.applySuggestions, {
	label: () => t('postbox.senders.operations.apply'),
});

async function applySuggestions() {
	const result = await applyOp.run({
		mailboxId: props.mailboxId,
		senderDigests: suggestions.value.map((row) => row.senderDigest),
	});
	isDialogOpen.value = false;
	if (!result.ok) return;
	const applied = result.result.applied;
	showToast(t('postbox.senders.toast.applied', { count: applied }, applied));
}
</script>

<template>
	<section class="card !p-0">
		<header class="px-5 pt-4 pb-3 border-b border-border-subtle">
			<h1 class="text-lg font-semibold text-text-primary">{{ t('postbox.senders.heading') }}</h1>
			<p class="text-sm text-text-secondary">{{ t('postbox.senders.subtitle') }}</p>
			<UiTabs v-model="tab" :tabs="tabs" class="mt-3" />
		</header>

		<div v-if="isLoading" class="p-8 flex justify-center">
			<Icon
				name="lucide:loader-2"
				class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
			/>
		</div>
		<!-- A failed read is not "no senders" (#721). -->
		<UiQueryBoundary v-else-if="error" :error="error" @retry="retry" />
		<div v-else-if="rows.length === 0" class="p-8 text-center">
			<p class="text-text-secondary">{{ t(`postbox.senders.empty.${tab}`) }}</p>
		</div>
		<div v-else class="px-5 overflow-x-auto">
			<table class="w-full text-left">
				<thead>
					<tr class="text-xs text-text-tertiary">
						<th class="py-2 pr-3 font-medium">{{ t('postbox.senders.columns.sender') }}</th>
						<th class="py-2 pr-3 font-medium whitespace-nowrap">
							{{ t('postbox.senders.columns.mails') }}
						</th>
						<th class="py-2 pr-3 font-medium whitespace-nowrap">
							{{ t('postbox.senders.columns.read') }}
						</th>
						<th class="py-2 pr-3 font-medium">{{ t('postbox.senders.columns.kind') }}</th>
						<th class="py-2 font-medium whitespace-nowrap">
							{{ t('postbox.senders.columns.action') }}
						</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-border-subtle">
					<PostboxSenderRow
						v-for="row in rows"
						:key="row.senderDigest"
						:row="row"
						:busy="actions.isBusy.value"
						@set-status="(status) => onSetStatus(row, status)"
						@resume="actions.resumeDrafts(targetOf(row))"
					/>
				</tbody>
			</table>
			<div v-if="tab !== 'review' && list.status.value === 'CanLoadMore'" class="py-3 text-center">
				<UiButton variant="secondary" size="sm" @click="list.loadMore(50)">
					{{ t('postbox.senders.loadMore') }}
				</UiButton>
			</div>
		</div>

		<footer
			v-if="tab === 'review' && suggestions.length > 0"
			class="px-5 py-3 border-t border-border-subtle flex flex-wrap items-center gap-3"
		>
			<UiButton size="sm" :loading="applyOp.isLoading.value" @click="isDialogOpen = true">
				{{ t('postbox.senders.apply', { count: suggestions.length }, suggestions.length) }}
			</UiButton>
			<p class="text-xs text-text-tertiary">{{ t('postbox.senders.applyRule') }}</p>
		</footer>

		<UiConfirmationDialog
			v-model:open="isDialogOpen"
			:title="t('postbox.senders.dialog.title', { count: suggestions.length }, suggestions.length)"
			:description="t('postbox.senders.dialog.description')"
			:confirm-text="t('postbox.senders.dialog.confirm')"
			:is-loading="applyOp.isLoading.value"
			@confirm="applySuggestions"
		>
			<ul
				class="mt-4 w-full max-h-64 overflow-y-auto text-left text-sm divide-y divide-border-subtle"
			>
				<li v-for="row in suggestions" :key="row.senderDigest" class="py-2 flex items-center gap-3">
					<span class="min-w-0 flex-1 truncate">{{ senderName(row) }}</span>
					<span class="shrink-0 text-text-secondary">
						{{ t(`postbox.senders.suggestion.${row.suggestion}`) }}
					</span>
				</li>
			</ul>
		</UiConfirmationDialog>
	</section>
</template>
