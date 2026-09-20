<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import TaskCardShell from '~/components/agent-tasks/TaskCardShell.vue';
import { categoryIcon } from '~/utils/agentCategories';
import { localizedSummary } from '~/utils/clarificationLocale';
import { formatDateTime } from '~/utils/formatters';
import { isEditableTarget } from '~/utils/postboxShortcuts';

/**
 * Updates — the team-inbox dashboard of mail that needs no reply.
 *
 * The agent pipeline parks a message here (`informational`) when the sender is
 * not waiting for an answer, so nothing is drafted and nothing sits in the
 * review queue for it. Four tabs split it by the classifier's kind:
 *
 *   - Updates        a human keeping us informed — ranked by importance
 *   - Promotions     adverts, cold pitches and newsletters
 *   - Notifications  automated system mail and receipts
 *   - Spam           what the classifier archived as spam (read-only; the
 *                    one action is blocking the sender)
 *
 * Keyboard-first: j/k move, Enter opens the thread, d dismisses, r asks the
 * agent for a draft after all (the classifier can be wrong; the overrule goes
 * through the normal review queue and can never auto-send).
 *
 * The one-sentence summary is read in the reader's own interface language —
 * the classifier writes one per shipped locale.
 */
const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.inbox.updates.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

type UpdateView = 'updates' | 'promotions' | 'notifications' | 'spam';
const VIEWS: ReadonlyArray<{ key: UpdateView; icon: string }> = [
	{ key: 'updates', icon: 'lucide:newspaper' },
	{ key: 'promotions', icon: 'lucide:megaphone' },
	{ key: 'notifications', icon: 'lucide:bell' },
	{ key: 'spam', icon: 'lucide:shield-off' },
];

const route = useRoute();
const router = useRouter();
const view = computed<UpdateView>(() => {
	const raw = route.query['view'];
	return VIEWS.some((v) => v.key === raw) ? (raw as UpdateView) : 'updates';
});
function setView(next: UpdateView) {
	void router.replace({ query: { ...route.query, view: next === 'updates' ? undefined : next } });
}

type UpdateItem = FunctionReturnType<typeof api.inbox.updates.listUpdates>[number];
interface UpdateRow {
	_id: Id<'inboundMessages'>;
	item: UpdateItem;
}

const {
	data: updates,
	isLoading,
	error,
} = useConvexQuery(api.inbox.updates.listUpdates, () => ({ limit: 50, view: view.value }));
const { data: counts } = useConvexQuery(api.inbox.updates.getUpdateCounts, () => ({}));

const rows = computed<UpdateRow[]>(() =>
	(updates.value ?? []).map((item) => ({ _id: item.message._id, item }))
);

// Optimistic row removal — dismiss / request-reply hide the row immediately and
// the live subscription confirms it; a failed action restores the row.
const { visible: visibleRows, hide: hideRow, unhide: unhideRow } = usePostboxOptimisticHide(rows);

const { run: dismissUpdate } = useBackendOperation(api.inbox.updates.dismissUpdate, {
	label: () => t('dashboard.inbox.updates.dismissOperation'),
});
const { run: requestReply } = useBackendOperation(api.inbox.updates.requestReply, {
	label: () => t('dashboard.inbox.updates.requestReplyOperation'),
});
const { run: blockSender } = useBackendOperation(api.inbox.mutations.blockSender, {
	label: () => t('dashboard.inbox.updates.blockOperation'),
});

const { showToast } = useToast();
const { isAdmin } = usePermissions();
const actionInProgress = ref<string | null>(null);
const isSpamView = computed(() => view.value === 'spam');

async function onDismiss(row: UpdateRow) {
	if (!isAdmin.value || actionInProgress.value || isSpamView.value) return;
	actionInProgress.value = row._id;
	hideRow(row._id);
	try {
		const result = await dismissUpdate({ inboundMessageId: row._id });
		if (!result.ok) {
			unhideRow(row._id);
			return;
		}
		showToast(t('dashboard.inbox.updates.dismissedToast'));
	} finally {
		actionInProgress.value = null;
	}
}

async function onRequestReply(row: UpdateRow) {
	if (!isAdmin.value || actionInProgress.value || isSpamView.value) return;
	actionInProgress.value = row._id;
	hideRow(row._id);
	try {
		const result = await requestReply({ inboundMessageId: row._id });
		if (!result.ok) {
			unhideRow(row._id);
			return;
		}
		showToast(t('dashboard.inbox.updates.replyRequestedToast'), 'success', {
			action: {
				label: t('dashboard.inbox.updates.openReviewQueue'),
				onAction: () => void navigateTo('/dashboard/inbox/review'),
			},
		});
	} finally {
		actionInProgress.value = null;
	}
}

// Blocking a sender is lasting, so it is confirmed first.
const pendingBlock = ref<UpdateRow | null>(null);
async function confirmBlock() {
	const row = pendingBlock.value;
	pendingBlock.value = null;
	if (!row || !isAdmin.value) return;
	actionInProgress.value = row._id;
	hideRow(row._id);
	try {
		const result = await blockSender({ inboundMessageId: row._id });
		if (!result.ok) {
			unhideRow(row._id);
			return;
		}
		showToast(t('dashboard.inbox.updates.blockedToast'));
	} finally {
		actionInProgress.value = null;
	}
}

function openThread(row: UpdateRow) {
	const threadId = row.item.message.threadId;
	if (threadId) navigateTo(`/dashboard/inbox/${threadId}`);
}

const rowDomId = (row: UpdateRow) => `update-${row._id}`;
const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard<UpdateRow>({
	items: visibleRows,
	resetKey: view,
	rowDomId,
	scope: 'review',
	onActivate: openThread,
	onAction: (key, row) => {
		if (key === 'd') void onDismiss(row);
		else if (key === 'r') void onRequestReply(row);
	},
});

function onListKeydown(event: KeyboardEvent) {
	if (isEditableTarget(event.target)) return;
	onKeydown(event);
}

function senderLabel(item: UpdateItem): string {
	const contact = item.contact;
	const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
	return name || item.message.from;
}

function summaryFor(item: UpdateItem): string | undefined {
	return localizedSummary(item.message.classification?.summary, locale.value);
}

function importanceTone(item: UpdateItem): 'high' | 'normal' | 'low' {
	const importance = item.message.classification?.importance ?? 0;
	if (item.message.classification?.priority === 'urgent' || importance >= 0.7) return 'high';
	if (importance >= 0.4) return 'normal';
	return 'low';
}

const TONE_CLASS: Record<ReturnType<typeof importanceTone>, string> = {
	high: 'text-warning bg-warning/10',
	normal: 'text-brand bg-brand-subtle',
	low: 'text-text-tertiary bg-bg-surface',
};

function categoryLabel(category: string | undefined): string {
	const key = `dashboard.inbox.detail.categories.${category ?? 'other'}`;
	return t(key) === key ? (category ?? '') : t(key);
}

function kindLabel(kind: string | undefined): string | undefined {
	if (!kind) return undefined;
	const key = `dashboard.inbox.updates.kinds.${kind}`;
	return t(key) === key ? undefined : t(key);
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-start justify-between gap-4 mb-6">
			<div class="flex items-center gap-4">
				<NuxtLink
					to="/dashboard/inbox"
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
				</NuxtLink>
				<div>
					<h1
						class="text-2xl font-medium tracking-[-0.02em] text-text-primary flex items-center gap-3"
					>
						<Icon name="lucide:newspaper" class="w-7 h-7 text-brand" />
						{{ t('dashboard.inbox.updates.title') }}
					</h1>
					<p class="text-text-secondary mt-1">
						{{ t('dashboard.inbox.updates.subtitle') }}
					</p>
				</div>
			</div>
			<div class="hidden md:flex items-center gap-3 text-xs text-text-tertiary" aria-hidden="true">
				<span
					><kbd class="font-mono">j</kbd>/<kbd class="font-mono">k</kbd>
					{{ t('dashboard.inbox.updates.hintMove') }}</span
				>
				<span><kbd class="font-mono">Enter</kbd> {{ t('dashboard.inbox.updates.hintOpen') }}</span>
				<template v-if="!isSpamView">
					<span><kbd class="font-mono">d</kbd> {{ t('dashboard.inbox.updates.dismiss') }}</span>
					<span
						><kbd class="font-mono">r</kbd> {{ t('dashboard.inbox.updates.requestReply') }}</span
					>
				</template>
			</div>
		</div>

		<!-- Tabs -->
		<div
			role="tablist"
			:aria-label="t('dashboard.inbox.updates.tabsAriaLabel')"
			class="mb-6 flex flex-wrap gap-1 border-b border-border-subtle"
		>
			<button
				v-for="tab in VIEWS"
				:key="tab.key"
				type="button"
				role="tab"
				:aria-selected="view === tab.key"
				:data-testid="`updates-tab-${tab.key}`"
				class="inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors"
				:class="
					view === tab.key
						? 'border-brand text-text-primary font-medium'
						: 'border-transparent text-text-secondary hover:text-text-primary'
				"
				@click="setView(tab.key)"
			>
				<Icon :name="tab.icon" class="w-4 h-4" />
				{{ t(`dashboard.inbox.updates.tabs.${tab.key}`) }}
				<span
					v-if="counts && counts[tab.key] > 0"
					class="ml-0.5 rounded-full bg-bg-surface px-1.5 text-xs text-text-tertiary"
					>{{ counts[tab.key] }}</span
				>
			</button>
		</div>

		<p v-if="isSpamView" class="mb-4 text-xs text-text-tertiary" data-testid="spam-note">
			{{ t('dashboard.inbox.updates.spamNote') }}
		</p>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:empty="!updates || visibleRows.length === 0"
			:error-title="t('dashboard.inbox.updates.errorTitle')"
			:error-message="t('dashboard.inbox.updates.errorMessage')"
			:loading-label="t('dashboard.inbox.updates.loading')"
		>
			<template #empty>
				<UiEmptyState
					icon="lucide:check-check"
					:title="t(`dashboard.inbox.updates.empty.${view}.title`)"
					:description="t(`dashboard.inbox.updates.empty.${view}.body`)"
				/>
			</template>

			<ul
				role="listbox"
				:aria-label="t('dashboard.inbox.updates.listAriaLabel')"
				:aria-activedescendant="activeId"
				tabindex="0"
				class="space-y-3 outline-none"
				@keydown="onListKeydown"
			>
				<TaskCardShell
					v-for="(row, index) in visibleRows"
					:id="rowDomId(row)"
					:key="row._id"
					as="li"
					role="option"
					:aria-selected="index === focusedIndex"
					:focused="index === focusedIndex"
					:spine="false"
					data-testid="update-row"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 flex-wrap">
								<span
									v-if="!isSpamView"
									class="text-xs px-2 py-0.5 rounded-full"
									:class="TONE_CLASS[importanceTone(row.item)]"
								>
									{{ t(`dashboard.inbox.updates.importance.${importanceTone(row.item)}`) }}
								</span>
								<span
									v-if="kindLabel(row.item.message.classification?.kind)"
									class="text-xs px-2 py-0.5 rounded-full bg-bg-surface text-text-tertiary"
								>
									{{ kindLabel(row.item.message.classification?.kind) }}
								</span>
								<span
									v-if="row.item.message.classification?.category"
									class="inline-flex items-center gap-1 text-xs text-text-tertiary"
								>
									<Icon
										:name="categoryIcon(row.item.message.classification.category)"
										class="w-3 h-3"
									/>
									{{ categoryLabel(row.item.message.classification.category) }}
								</span>
								<span class="text-xs text-text-tertiary">
									{{ formatDateTime(row.item.message.receivedAt) }}
								</span>
							</div>
							<p class="mt-1.5 text-sm font-semibold text-text-primary truncate">
								{{ row.item.message.subject || t('dashboard.inbox.updates.noSubject') }}
							</p>
							<p class="text-xs text-text-tertiary truncate">{{ senderLabel(row.item) }}</p>
							<p
								v-if="summaryFor(row.item)"
								class="mt-2 text-sm text-text-secondary"
								data-testid="update-summary"
							>
								{{ summaryFor(row.item) }}
							</p>
						</div>
						<div v-if="isAdmin" class="flex items-center gap-1 shrink-0">
							<UiButton
								variant="ghost"
								size="sm"
								class="gap-1"
								:disabled="actionInProgress === row._id"
								@click.stop="openThread(row)"
							>
								<Icon name="lucide:external-link" class="w-3 h-3" />
								{{ t('dashboard.inbox.updates.open') }}
							</UiButton>
							<template v-if="isSpamView">
								<UiButton
									variant="ghost"
									size="sm"
									class="gap-1 text-error hover:bg-error-subtle"
									:disabled="actionInProgress === row._id"
									@click.stop="pendingBlock = row"
								>
									<Icon name="lucide:ban" class="w-3 h-3" />
									{{ t('dashboard.inbox.updates.blockSender') }}
								</UiButton>
							</template>
							<template v-else>
								<UiButton
									variant="ghost"
									size="sm"
									class="gap-1"
									:disabled="actionInProgress === row._id"
									@click.stop="onRequestReply(row)"
								>
									<Icon name="lucide:reply" class="w-3 h-3" />
									{{ t('dashboard.inbox.updates.requestReply') }}
								</UiButton>
								<UiButton
									variant="secondary"
									size="sm"
									class="gap-1"
									:disabled="actionInProgress === row._id"
									@click.stop="onDismiss(row)"
								>
									<Icon name="lucide:check" class="w-3 h-3" />
									{{ t('dashboard.inbox.updates.dismiss') }}
								</UiButton>
							</template>
						</div>
					</div>
				</TaskCardShell>
			</ul>
		</UiQueryBoundary>

		<UiConfirmationDialog
			v-if="isAdmin"
			:open="!!pendingBlock"
			variant="danger"
			:title="t('dashboard.inbox.updates.blockDialogTitle')"
			:description="
				t('dashboard.inbox.updates.blockDialogDescription', {
					sender: pendingBlock?.item.message.from ?? '',
				})
			"
			:confirm-text="t('dashboard.inbox.updates.blockDialogConfirm')"
			:is-loading="!!pendingBlock && actionInProgress === pendingBlock._id"
			@update:open="
				(v: boolean) => {
					if (!v) pendingBlock = null;
				}
			"
			@confirm="confirmBlock"
		/>
	</div>
</template>
