<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import InboxUpdateRow, {
	DOT_CLASS,
	TONE_ORDER,
	importanceTone,
	type Tone,
	type UpdateItem,
} from '~/components/inbox/InboxUpdateRow.vue';
import { useReviewListKeys } from '~/composables/useReviewListKeys';
import { useUpdatesDismissSweep } from '~/composables/useUpdatesDismissSweep';
import PostboxSweepStatus from '~/components/postbox/PostboxSweepStatus.vue';
import { ArrowLeftIcon } from '@coolicons/vue';
import { UPDATE_VIEWS, type UpdateView } from '~/lib/inboxUpdateViews';

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
 * A row shows the subject and the first lines of the message as the sender
 * wrote them (`preview`, quoted history cut). No model-written summary:
 * an old row's stored classifier summary is not shown.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.inbox.updates.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const route = useRoute();
const router = useRouter();
const view = computed<UpdateView>(() => {
	const raw = route.query['view'];
	return UPDATE_VIEWS.some((v) => v.key === raw) ? (raw as UpdateView) : 'updates';
});
function setView(next: UpdateView) {
	void router.replace({ query: { ...route.query, view: next === 'updates' ? undefined : next } });
}

// The tabs follow the tab pattern: one tab stop, arrow keys (Home/End too)
// move to the next view, and the list below is the panel they label.
const updatesPanelId = useId();
const tabDomId = (key: UpdateView) => `updates-tab-${key}`;
function onTabKeydown(event: KeyboardEvent) {
	const keys = UPDATE_VIEWS.map((v) => v.key);
	const at = keys.indexOf(view.value);
	let next: UpdateView | undefined;
	if (event.key === 'ArrowRight') next = keys[(at + 1) % keys.length];
	else if (event.key === 'ArrowLeft') next = keys[(at - 1 + keys.length) % keys.length];
	else if (event.key === 'Home') next = keys[0];
	else if (event.key === 'End') next = keys[keys.length - 1];
	if (!next) return;
	event.preventDefault();
	setView(next);
	const id = tabDomId(next);
	void nextTick(() => document.getElementById(id)?.focus());
}

interface UpdateRow {
	_id: Id<'inboundMessages'>;
	item: UpdateItem;
}

const {
	data: updates,
	isLoading,
	error,
	refetch,
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
				label: t('dashboard.inbox.updates.openAnswerQueue'),
				onAction: () => void navigateTo({ path: '/dashboard/answer', query: { in: 'team' } }),
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

/** The rows in the order they render, which both the keyboard and a sweep walk. */
const displayRows = computed(() => groups.value.flatMap((group) => group.rows));

/** Position of a row in the flat keyboard order, for the listbox focus ring. */
function flatIndex(row: UpdateRow): number {
	return displayRows.value.findIndex((r) => r._id === row._id);
}

const rowDomId = (row: UpdateRow) => `update-${row._id}`;
const { focusedIndex, activeId, onKeydown, hints } = useReviewListKeys<UpdateRow>({
	items: displayRows,
	resetKey: view,
	rowDomId,
	onOpen: openThread,
	onDismiss: (row) => void onDismiss(row),
	onRequestReply: (row) => void onRequestReply(row),
});

const dismissSweep = useUpdatesDismissSweep({
	rows: displayRows,
	scopeKey: () => view.value,
	canDismiss: () => isAdmin.value && !isSpamView.value,
	actionInProgress,
	rowHide: { hide: hideRow, unhide: unhideRow },
});
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<!-- Header: the back arrow beside the shared header, which puts the key
		     hints under the title on narrow screens instead of squeezing both.
		     Below md the hint pill is hidden, so the header drops its gap rather
		     than leaving an empty action row above the tabs. -->
		<div class="mb-6 flex items-start gap-4">
			<NuxtLink
				to="/dashboard/inbox"
				class="mt-7.5 inline-flex items-center gap-2 text-text-secondary transition-colors duration-(--motion-fast) hover:text-text-primary"
				:aria-label="t('dashboard.inbox.detail.backToInbox')"
			>
				<ArrowLeftIcon class="h-4 w-4" />
			</NuxtLink>
			<UiPageHeader
				class="min-w-0 flex-1 max-md:gap-0"
				:eyebrow="t('shared.dashboardNavigation.sections.inbox')"
				:title="t('dashboard.inbox.updates.title')"
				:description="t('dashboard.inbox.updates.subtitle')"
			>
				<template #actions>
					<div
						class="hidden flex-wrap items-center gap-x-3 gap-y-1 rounded-full surface-1 px-3.5 py-1.5 text-2xs text-text-tertiary md:flex"
						aria-hidden="true"
					>
						<template v-for="hint in hints" :key="hint.label">
							<span
								v-if="!hint.notInSpam || !isSpamView"
								class="inline-flex items-center gap-1 whitespace-nowrap"
							>
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
				</template>
			</UiPageHeader>
		</div>

		<!-- Tabs -->
		<div
			role="tablist"
			:aria-label="t('dashboard.inbox.updates.tabsAriaLabel')"
			class="mb-6 flex flex-wrap gap-1 border-b border-border-subtle"
		>
			<button
				v-for="tab in UPDATE_VIEWS"
				:id="tabDomId(tab.key)"
				:key="tab.key"
				type="button"
				role="tab"
				:aria-selected="view === tab.key"
				:aria-controls="updatesPanelId"
				:tabindex="view === tab.key ? 0 : -1"
				:data-testid="`updates-tab-${tab.key}`"
				@keydown="onTabKeydown"
				class="-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-(--motion-moderate) ease-spring"
				:class="
					view === tab.key
						? 'border-brand font-medium text-text-primary'
						: 'border-transparent text-text-secondary hover:text-text-primary'
				"
				@click="setView(tab.key)"
			>
				<component :is="tab.icon" class="h-4 w-4" />
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
			class="mb-4 max-w-prose text-caption text-text-tertiary"
			data-testid="spam-note"
		>
			{{ t('dashboard.inbox.updates.spamNote') }}
		</p>

		<div :id="updatesPanelId" role="tabpanel" :aria-labelledby="tabDomId(view)">
			<UiQueryBoundary
				:loading="isLoading"
				:error="error"
				@retry="refetch"
				:empty="!updates || visibleRows.length === 0"
				:error-title="t('dashboard.inbox.updates.errorTitle')"
				:error-message="t('dashboard.inbox.updates.errorMessage')"
				:loading-label="t('dashboard.inbox.updates.loading')"
			>
				<template #empty>
					<!-- Caught up / no spam is the good outcome: "all clear", not "nothing yet". -->
					<UiEmptyState
						:tone="view === 'updates' || view === 'spam' ? 'clear' : 'default'"
						:title="t(`dashboard.inbox.updates.empty.${view}.title`)"
						:description="t(`dashboard.inbox.updates.empty.${view}.body`)"
					/>
				</template>

				<ul
					role="listbox"
					:aria-label="t('dashboard.inbox.updates.listAriaLabel')"
					:aria-activedescendant="activeId"
					tabindex="0"
					:ref="dismissSweep.listEl"
					class="space-y-8 outline-none"
					:class="{ 'select-none': dismissSweep.active.value }"
					@keydown="onKeydown"
				>
					<li v-for="group in groups" :key="group.tone ?? 'all'" role="presentation">
						<div v-if="group.tone" class="mb-3 flex items-center gap-2">
							<span
								class="h-1.5 w-1.5 rounded-full"
								:class="DOT_CLASS[group.tone]"
								aria-hidden="true"
							/>
							<span class="text-2xs font-medium uppercase tracking-wide text-text-tertiary">{{
								t(`dashboard.inbox.updates.importance.${group.tone}`)
							}}</span>
							<span class="text-2xs tabular-nums text-text-tertiary">{{ group.rows.length }}</span>
						</div>
						<ul role="presentation" class="space-y-3">
							<InboxUpdateRow
								v-for="row in group.rows"
								:key="row._id"
								:row-id="row._id"
								:item="row.item"
								:option-id="rowDomId(row)"
								:focused="flatIndex(row) === focusedIndex"
								:is-spam-view="isSpamView"
								:is-admin="isAdmin"
								:busy="actionInProgress === row._id"
								:swept-for-dismiss="dismissSweep.markOf(row._id) === 'dismiss'"
								@open="openThread(row)"
								@block="pendingBlock = row"
								@request-reply="onRequestReply(row)"
								@dismiss="onDismiss(row)"
								@sweep-start="dismissSweep.start(row._id, $event)"
							/>
						</ul>
					</li>
				</ul>
			</UiQueryBoundary>
		</div>
		<PostboxSweepStatus :status="dismissSweep.status.value" />

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
