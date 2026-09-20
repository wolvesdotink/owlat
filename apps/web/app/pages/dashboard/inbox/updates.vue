<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
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
 *   - Updates        a human keeping us informed — grouped by importance
 *   - Promotions     adverts, cold pitches and newsletters
 *   - Notifications  automated system mail and receipts
 *   - Spam           what the classifier archived as spam (read-only; the
 *                    one action is blocking the sender)
 *
 * Keyboard-first: j/k move, Enter opens the thread, d dismisses, r asks the
 * agent for a draft after all (the classifier can be wrong; the overrule goes
 * through the normal review queue and can never auto-send).
 *
 * The one-sentence summary is the point of a row, so it is the largest line;
 * it is read in the reader's own interface language — the classifier writes
 * one per shipped locale.
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

type Tone = 'high' | 'normal' | 'low';
function importanceTone(item: UpdateItem): Tone {
	const importance = item.message.classification?.importance ?? 0;
	if (item.message.classification?.priority === 'urgent' || importance >= 0.7) return 'high';
	if (importance >= 0.4) return 'normal';
	return 'low';
}

/** Quiet status dot per importance — a tint, never a fill. */
const DOT_CLASS: Record<Tone, string> = {
	high: 'bg-warning',
	normal: 'bg-brand',
	low: 'bg-text-tertiary/50',
};
const TONE_ORDER: readonly Tone[] = ['high', 'normal', 'low'];

/**
 * The list grouped by importance in a fixed order, so the eye lands on what
 * matters first and the keyboard walks the same order the groups render in.
 * The spam view is one flat group (importance is meaningless there).
 */
const groups = computed<{ tone: Tone | null; rows: UpdateRow[] }[]>(() => {
	if (isSpamView.value) return [{ tone: null, rows: visibleRows.value }];
	return TONE_ORDER.map((tone) => ({
		tone,
		rows: visibleRows.value.filter((row) => importanceTone(row.item) === tone),
	})).filter((group) => group.rows.length > 0);
});

/** Position of a row in the flat keyboard order, for the listbox focus ring. */
function flatIndex(row: UpdateRow): number {
	return visibleRows.value.findIndex((r) => r._id === row._id);
}

function categoryLabel(category: string | undefined): string {
	const key = `dashboard.inbox.detail.categories.${category ?? 'other'}`;
	return t(key) === key ? (category ?? '') : t(key);
}

function kindLabel(kind: string | undefined): string | undefined {
	if (!kind) return undefined;
	const key = `dashboard.inbox.updates.kinds.${kind}`;
	return t(key) === key ? undefined : t(key);
}

const HINTS: ReadonlyArray<{ keys: string[]; label: string; spamToo: boolean }> = [
	{ keys: ['j', 'k'], label: 'dashboard.inbox.updates.hintMove', spamToo: true },
	{ keys: ['Enter'], label: 'dashboard.inbox.updates.hintOpen', spamToo: true },
	{ keys: ['d'], label: 'dashboard.inbox.updates.dismiss', spamToo: false },
	{ keys: ['r'], label: 'dashboard.inbox.updates.requestReply', spamToo: false },
];
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6 flex items-start justify-between gap-4">
			<div class="flex items-start gap-4">
				<NuxtLink
					to="/dashboard/inbox"
					class="mt-2 inline-flex items-center gap-2 text-text-secondary transition-colors duration-(--motion-fast) hover:text-text-primary"
				>
					<Icon name="lucide:arrow-left" class="h-4 w-4" />
				</NuxtLink>
				<div>
					<span class="lp-eyebrow">{{ t('shared.dashboardNavigation.sections.inbox') }}</span>
					<h1 class="mt-1 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.inbox.updates.title') }}
					</h1>
					<p class="mt-1 max-w-[540px] text-text-secondary">
						{{ t('dashboard.inbox.updates.subtitle') }}
					</p>
				</div>
			</div>
			<div
				class="hidden items-center gap-3 rounded-full surface-1 px-3.5 py-1.5 text-2xs text-text-tertiary md:flex"
				aria-hidden="true"
			>
				<template v-for="hint in HINTS" :key="hint.label">
					<span v-if="hint.spamToo || !isSpamView" class="inline-flex items-center gap-1">
						<kbd
							v-for="key in hint.keys"
							:key="key"
							class="rounded-md bg-bg-elevated px-1 font-mono text-text-secondary"
							>{{ key }}</kbd
						>
						{{ t(hint.label) }}
					</span>
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
				class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-(--motion-moderate) ease-spring"
				:class="
					view === tab.key
						? 'border-brand font-medium text-text-primary'
						: 'border-transparent text-text-secondary hover:text-text-primary'
				"
				@click="setView(tab.key)"
			>
				<Icon :name="tab.icon" class="h-4 w-4" />
				{{ t(`dashboard.inbox.updates.tabs.${tab.key}`) }}
				<span
					v-if="counts && counts[tab.key] > 0"
					class="ml-0.5 rounded-full surface-1 px-1.5 py-px text-2xs tabular-nums text-text-tertiary"
					>{{ counts[tab.key] }}</span
				>
			</button>
		</div>

		<p
			v-if="isSpamView"
			class="mb-4 max-w-[540px] text-caption text-text-tertiary"
			data-testid="spam-note"
		>
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
				class="space-y-8 outline-none"
				@keydown="onListKeydown"
			>
				<li v-for="group in groups" :key="group.tone ?? 'all'" role="presentation">
					<div v-if="group.tone" class="mb-3 flex items-center gap-2">
						<span
							class="h-1.5 w-1.5 rounded-full"
							:class="DOT_CLASS[group.tone]"
							aria-hidden="true"
						/>
						<span class="lp-eyebrow">{{
							t(`dashboard.inbox.updates.importance.${group.tone}`)
						}}</span>
						<span class="text-2xs tabular-nums text-text-tertiary">{{ group.rows.length }}</span>
					</div>
					<ul role="presentation" class="space-y-3">
						<li
							v-for="row in group.rows"
							:id="rowDomId(row)"
							:key="row._id"
							role="option"
							:aria-selected="flatIndex(row) === focusedIndex"
							class="group lp-card p-4 outline-none"
							:class="flatIndex(row) === focusedIndex ? 'ring-2 ring-brand/60' : ''"
							data-testid="update-row"
						>
							<div class="flex items-start gap-3">
								<UiAvatar
									:name="senderLabel(row.item)"
									:email="row.item.message.from"
									size="md"
									deterministic-color
									class="mt-0.5 shrink-0"
								/>
								<div class="min-w-0 flex-1">
									<div class="flex items-start justify-between gap-4">
										<div class="min-w-0">
											<p class="flex items-center gap-2 text-sm font-semibold text-text-primary">
												<span
													v-if="!isSpamView"
													class="h-1.5 w-1.5 shrink-0 rounded-full"
													:class="DOT_CLASS[importanceTone(row.item)]"
													:title="
														t(`dashboard.inbox.updates.importance.${importanceTone(row.item)}`)
													"
												/>
												<span class="truncate">{{
													row.item.message.subject || t('dashboard.inbox.updates.noSubject')
												}}</span>
											</p>
											<p class="mt-0.5 truncate text-caption text-text-tertiary">
												<span class="text-text-secondary">{{ senderLabel(row.item) }}</span>
												<span class="mx-1 opacity-50">·</span>
												{{ formatDateTime(row.item.message.receivedAt) }}
												<template v-if="kindLabel(row.item.message.classification?.kind)">
													<span class="mx-1 opacity-50">·</span>
													{{ kindLabel(row.item.message.classification?.kind) }}
												</template>
												<template v-if="row.item.message.classification?.category">
													<span class="mx-1 opacity-50">·</span>
													<Icon
														:name="categoryIcon(row.item.message.classification.category)"
														class="inline-block h-3 w-3 align-[-2px]"
													/>
													{{ categoryLabel(row.item.message.classification.category) }}
												</template>
											</p>
										</div>
										<div
											v-if="isAdmin"
											class="flex shrink-0 items-center gap-1 opacity-70 transition-opacity duration-(--motion-fast) group-hover:opacity-100 group-focus-within:opacity-100"
										>
											<UiButton
												variant="ghost"
												size="sm"
												class="gap-1"
												:disabled="actionInProgress === row._id"
												@click.stop="openThread(row)"
											>
												<Icon name="lucide:external-link" class="h-3 w-3" />
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
													<Icon name="lucide:ban" class="h-3 w-3" />
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
													<Icon name="lucide:reply" class="h-3 w-3" />
													{{ t('dashboard.inbox.updates.requestReply') }}
												</UiButton>
												<UiButton
													variant="secondary"
													size="sm"
													class="gap-1"
													:disabled="actionInProgress === row._id"
													@click.stop="onDismiss(row)"
												>
													<Icon name="lucide:check" class="h-3 w-3" />
													{{ t('dashboard.inbox.updates.dismiss') }}
												</UiButton>
											</template>
										</div>
									</div>
									<p
										v-if="summaryFor(row.item)"
										class="mt-2 text-md leading-snug text-text-secondary"
										data-testid="update-summary"
									>
										{{ summaryFor(row.item) }}
									</p>
								</div>
							</div>
						</li>
					</ul>
				</li>
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
