<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { answerCounts } from '~/composables/useAnswerQueue';
import { answerItemMatches } from '~/utils/answerQueue';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { TodayChange, TodayLine, TodaySource } from '~/utils/todayDigest';
import { TODAY_PEEK, peekKey, threadHref } from '~/utils/todayPeek';
import {
	TEAM_SCOPE,
	WORKBENCH_SCOPE_STORAGE_KEY,
	pickWorkbenchScope,
	workbenchTabs,
	type WorkbenchScope,
	type WorkbenchTab,
} from '~/utils/workbench';

/**
 * The Workbench — the home screen, one tab per inbox. Each tab summarises only
 * its own inbox and answers, in this order: does anything here need me (one
 * button into the Answer queue, narrowed to this inbox), what moved in the
 * conversations I already know, what should I know (important updates, one
 * sentence each, then routine mail), and what was filed away (newsletters,
 * notifications… as counts with a few senders, never as lines). Every
 * summarised phrase links, quietly, to the email it came from.
 *
 * Each tab has its own "since you last looked" watermark. It only moves on
 * purpose: "Mark as seen", finishing the Answer queue (which catches every tab
 * up), or a deliberate stay on a tab of at least half a minute before leaving.
 */
const { t } = useI18n();
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const { user } = useAuth();
const { hasActiveOrganization } = useOrganizationContext();
// The team-inbox tab (and its Done / Reply anyway) exists for admins only.
const { isAdmin } = usePermissions();
const { isEnabled } = useFeatureFlag();
const userId = computed(() => user.value?.id ?? null);
const firstName = computed(() => user.value?.name?.split(' ')[0] ?? '');

const route = useRoute();
const router = useRouter();
const { inboxes, byId, isLoading: inboxesLoading } = useInboxes();
const answer = useAnswerQueue();
const choice = useWorkbenchInboxChoice();
const { level: deliveryLevel, reason: deliveryReason } = useDeliveryHealth();
const { showToast } = useToast();

// ── Which tab ──────────────────────────────────────────────────────────────
const teamOn = computed(() => isAdmin.value && isEnabled('inbox'));
const remembered = ref<string | null>(null);
onMounted(() => {
	remembered.value = localStorage.getItem(WORKBENCH_SCOPE_STORAGE_KEY);
});
const allScopes = computed<WorkbenchScope[]>(() => [
	...inboxes.value.map((i) => i.mailboxId as string),
	...(teamOn.value ? [TEAM_SCOPE] : []),
]);
const shownScopes = computed(() => {
	const hidden = new Set<string>(choice.hiddenMailboxIds.value);
	return allScopes.value.filter((s) => !hidden.has(s));
});
const scope = computed(() =>
	pickWorkbenchScope({
		requested: route.query['inbox'],
		remembered: remembered.value,
		available: allScopes.value,
		shown: shownScopes.value,
	})
);
watch(scope, (next) => {
	if (next && import.meta.client) localStorage.setItem(WORKBENCH_SCOPE_STORAGE_KEY, next);
});
function selectScope(next: WorkbenchScope) {
	const { peek: _peek, ...rest } = route.query;
	void router.replace({ query: { ...rest, inbox: next } });
}

const isTeam = computed(() => scope.value === TEAM_SCOPE);
const inbox = computed(() =>
	scope.value && !isTeam.value ? (byId.value.get(scope.value as Id<'mailboxes'>) ?? null) : null
);
const scopeName = computed(() =>
	isTeam.value ? t('components.shell.teamInbox') : (inbox.value?.name ?? '')
);
useHead({
	title: () =>
		scopeName.value
			? `${scopeName.value} · ${t('dashboard.today.pageTitle')}`
			: t('dashboard.today.pageTitle'),
});

const tabs = computed<WorkbenchTab[]>(() =>
	workbenchTabs({
		inboxIds: allScopes.value.filter((s) => s !== TEAM_SCOPE),
		hidden: choice.hiddenMailboxIds.value,
		teamOn: teamOn.value,
		current: scope.value,
	}).map((s) => {
		const identity = s === TEAM_SCOPE ? null : byId.value.get(s as Id<'mailboxes'>);
		return {
			scope: s,
			name: identity?.name ?? t('components.shell.teamInbox'),
			slot: identity?.slot ?? null,
			address: identity?.address ?? null,
			isTeam: s === TEAM_SCOPE,
			answer: answer.items.value.filter((item) => answerItemMatches(item, s)).length,
			unread: identity?.unread ?? 0,
		};
	})
);

// ── This tab ───────────────────────────────────────────────────────────────
const workbench = useWorkbench(scope);
const scopedAnswer = computed(() =>
	scope.value ? answer.items.value.filter((item) => answerItemMatches(item, scope.value!)) : []
);
const scopedCounts = computed(() => answerCounts(scopedAnswer.value));
const mentions = computed(() => answer.counts.value.mention);
const answerHref = computed(() =>
	scope.value ? `/dashboard/answer?in=${encodeURIComponent(scope.value)}` : '/dashboard/answer'
);
const inboxHref = computed(() =>
	isTeam.value ? '/dashboard/inbox' : `/dashboard/postbox/inbox?mailbox=${scope.value}`
);
const moreHref = computed(() =>
	isTeam.value ? '/dashboard/inbox' : `/dashboard/inboxes?in=${scope.value}`
);

// Greeting
const hour = new Date().getHours();
const greetingKey = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

// Local hides so Done / Reply anyway feel instant; the live read confirms.
const hidden = ref(new Set<string>());
const model = computed(() => {
	const m = workbench.model.value;
	const keep = <T extends { key: string }>(list: readonly T[]) =>
		list.filter((l) => !hidden.value.has(l.key));
	return { ...m, changed: keep(m.changed), worth: keep(m.worth), also: keep(m.also) };
});

// The numbers live in the header's tiles; the sentence only says "since when".
const sinceLabel = computed(() => {
	const at = workbench.since.value;
	if (at === undefined) return '';
	if (workbench.isFallback.value) return t('components.today.scope.sinceFallback');
	const date = new Date(at);
	const sameDay = date.toDateString() === new Date().toDateString();
	const when = new Intl.DateTimeFormat(undefined, {
		...(sameDay ? {} : { weekday: 'long' }),
		hour: 'numeric',
		minute: '2-digit',
	}).format(date);
	return t('components.today.scope.since', { when });
});

const hasAnything = computed(
	() =>
		model.value.changed.length > 0 ||
		model.value.worth.length > 0 ||
		model.value.also.length > 0 ||
		model.value.newMail > 0 ||
		model.value.filedTotal > 0
);

// ── Mark as seen (with undo) + the deliberate-dwell rule, per tab ───────────
async function markAllSeen() {
	const target = scope.value;
	const result = await workbench.markSeen(target);
	if (!result.ok) return;
	hidden.value = new Set();
	showToast(t('dashboard.today.markedSeen', { inbox: scopeName.value }), 'success', {
		action: { label: t('common.undo'), onAction: () => void workbench.undoMarkSeen(target) },
	});
}
const DWELL_MS = 30_000;
let enteredAt = Date.now();
// The tabs that showed anything of their own while open; cleared on leaving.
// Tracked per tab: the previous tab stays on screen while the next one loads
// (`isStale`, which does not count), and two tabs that both have content never
// flip `hasAnything` at all.
const hadAnything = new Set<WorkbenchScope>();
watch(
	() => [scope.value, hasAnything.value && !workbench.isStale.value] as const,
	([current, showing]) => {
		if (current && showing) hadAnything.add(current);
	},
	{ immediate: true }
);
function leaveScope(previous: WorkbenchScope | null) {
	if (previous && hadAnything.has(previous) && Date.now() - enteredAt >= DWELL_MS)
		void workbench.markSeen(previous);
	if (previous) hadAnything.delete(previous);
}
watch(scope, (_next, previous) => {
	leaveScope(previous ?? null);
	enteredAt = Date.now();
	hidden.value = new Set();
});
onBeforeUnmount(() => leaveScope(scope.value));

// ── Actions on lines ────────────────────────────────────────────────────────
const { run: recordVisit } = useBackendOperation(api.mail.threadVisits.recordVisit, {
	label: () => t('dashboard.today.operations.done'),
});
const { run: dismissUpdate } = useBackendOperation(api.inbox.updates.dismissUpdate, {
	label: () => t('dashboard.today.operations.done'),
});
const { run: requestReply } = useBackendOperation(api.inbox.updates.requestReply, {
	label: () => t('dashboard.today.operations.replyAnyway'),
});

function unhide(key: string) {
	const next = new Set(hidden.value);
	next.delete(key);
	hidden.value = next;
}
async function doneLine(line: TodayLine | TodayChange) {
	hidden.value = new Set([...hidden.value, line.key]);
	const source = line.sources[0];
	let ok = true;
	if ('inboundMessageId' in line && line.inboundMessageId) {
		ok = (await dismissUpdate({ inboundMessageId: line.inboundMessageId as Id<'inboundMessages'> }))
			.ok;
	} else if (source?.kind === 'mail') {
		ok = (await recordVisit({ threadId: source.threadId as Id<'mailThreads'> })).ok;
	}
	if (!ok) unhide(line.key);
}
async function replyAnyway(line: TodayLine) {
	if (!line.inboundMessageId) return;
	hidden.value = new Set([...hidden.value, line.key]);
	const result = await requestReply({
		inboundMessageId: line.inboundMessageId as Id<'inboundMessages'>,
	});
	if (result.ok) {
		showToast(t('dashboard.today.replyRequested'), 'success', {
			action: {
				label: t('dashboard.today.openQueue'),
				onAction: () => void navigateTo(`/dashboard/answer?in=${TEAM_SCOPE}`),
			},
		});
	} else unhide(line.key);
}

// ── Peek panel (state in the URL) ───────────────────────────────────────────
const peekSources = ref<TodaySource[]>([]);
function openPeek(sources: TodaySource[], index = 0) {
	const target = sources[index];
	if (!target) return;
	peekSources.value = sources;
	void router.push({ query: { ...route.query, peek: peekKey(target) } });
}
function closePeek() {
	const { peek: _peek, ...rest } = route.query;
	void router.push({ query: rest });
}
provide(TODAY_PEEK, {
	open: openPeek,
	openThread: (source) => void navigateTo(threadHref(source)),
});
const allLines = computed(() => [
	...model.value.changed,
	...model.value.worth,
	...model.value.also,
]);
function onPeekDone(source: TodaySource) {
	const line = allLines.value.find((l) => l.sources.some((s) => s.id === source.id));
	closePeek();
	if (line) void doneLine(line);
}
function replyAnywayFromPeek(source: TodaySource) {
	const line = model.value.worth
		.concat(model.value.also)
		.find((l) => l.inboundMessageId === source.id);
	closePeek();
	if (line) void replyAnyway(line);
}

// ── Keyboard: j/k between lines, Enter opens, d done, r reply anyway ───────
function onKeydown(event: KeyboardEvent) {
	if (route.query['peek'] || event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const all = Array.from(document.querySelectorAll<HTMLElement>('[data-today-key]'));
	if (all.length === 0) return;
	const active = document.activeElement?.closest<HTMLElement>('[data-today-key]') ?? null;
	const index = active ? all.indexOf(active) : -1;
	if (event.key === 'j' || event.key === 'k') {
		event.preventDefault();
		const next = event.key === 'j' ? Math.min(all.length - 1, index + 1) : Math.max(0, index - 1);
		all[next]?.focus();
		return;
	}
	if (!active) return;
	const line = allLines.value.find((l) => l.key === active.dataset['todayKey']);
	if (!line) return;
	if (event.key === 'Enter') {
		event.preventDefault();
		openPeek(line.sources);
	} else if (event.key === 'd') {
		event.preventDefault();
		all[index + 1]?.focus();
		void doneLine(line);
	} else if (event.key === 'r' && 'inboundMessageId' in line && line.inboundMessageId) {
		event.preventDefault();
		void replyAnyway(line);
	}
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
	<div class="mx-auto w-full max-w-4xl px-6 pb-16 pt-8 lg:px-10">
		<header>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				<I18nT
					v-if="firstName"
					:keypath="`dashboard.today.greeting.${greetingKey}Named`"
					tag="span"
					scope="global"
				>
					<template #name
						><span class="lp-title-accent">{{ firstName }}</span></template
					>
				</I18nT>
				<template v-else>{{ t(`dashboard.today.greeting.${greetingKey}`) }}</template>
			</h1>
			<p class="mt-1 text-sm text-text-secondary">{{ t('dashboard.today.intro') }}</p>
		</header>

		<!-- Only when something is actually broken, and only for admins. -->
		<div class="mt-6 space-y-3 empty:hidden">
			<NuxtLink
				v-if="isAdmin && deliveryLevel === 'error'"
				to="/dashboard/admin/delivery"
				class="flex items-center gap-2 rounded-xl border border-error/30 bg-error-subtle px-4 py-2.5 text-sm text-error"
			>
				<Icon name="lucide:circle-alert" class="size-4" />
				<span class="flex-1">{{ deliveryReason || t('dashboard.today.deliveryAlert') }}</span>
				<span class="text-xs underline">{{ t('dashboard.today.openDelivery') }}</span>
			</NuxtLink>
			<DashboardAccessRequests v-if="hasActiveOrganization && isAdmin" />
			<DashboardMailboxRequests v-if="hasActiveOrganization && isAdmin" />
			<DashboardGettingStarted
				v-if="hasActiveOrganization && userId"
				:user-id="userId"
				:is-admin="isAdmin"
				compact
			/>
		</div>

		<div v-if="inboxesLoading && tabs.length === 0" class="mt-8 space-y-3">
			<UiSkeleton class="h-9 w-80" />
			<UiSkeleton class="h-36 w-full rounded-2xl" />
		</div>

		<!-- No inbox to work from yet. -->
		<div
			v-else-if="scope === null"
			class="mt-8 flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border-subtle px-6 py-8"
		>
			<Icon name="lucide:inbox" class="size-6 text-text-tertiary" />
			<div>
				<h2 class="text-base font-medium text-text-primary">
					{{ t('dashboard.today.noInbox.title') }}
				</h2>
				<p class="mt-1 max-w-lg text-sm text-text-secondary">
					{{ t('dashboard.today.noInbox.body') }}
				</p>
			</div>
			<UiButton to="/dashboard/preferences/add-account" size="sm">
				{{ t('dashboard.today.noInbox.cta') }}
			</UiButton>
		</div>

		<template v-else>
			<TodayWorkbenchTabs
				class="mt-8"
				:tabs="tabs"
				:selected="scope"
				panel-id="workbench-panel"
				@select="selectScope"
			>
				<template #end>
					<NuxtLink
						v-if="mentions > 0"
						to="/dashboard/answer?in=chat"
						class="mr-2 inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-0.5 text-2xs font-medium text-text-secondary hover:text-text-primary"
					>
						<Icon name="lucide:at-sign" class="size-3" />
						{{ t('dashboard.today.since.mentions', { count: mentions }, mentions) }}
					</NuxtLink>
					<TodayInboxPicker
						v-if="inboxes.length > 1"
						:inboxes="inboxes"
						:hidden="choice.hiddenMailboxIds.value"
						@toggle="choice.setInboxShown"
					/>
				</template>
			</TodayWorkbenchTabs>

			<div
				id="workbench-panel"
				:key="scope"
				role="tabpanel"
				:aria-labelledby="`workbench-tab-${scope}`"
				class="pt-6"
			>
				<TodayScopeHeader
					:name="scopeName"
					:slot="inbox?.slot ?? null"
					:address="inbox?.address ?? null"
					:kind="isTeam ? 'team' : (inbox?.scope ?? 'personal')"
					:since-label="sinceLabel"
					:is-loading="workbench.isLoading.value"
					:stats="{
						newMail: isTeam ? null : model.newMail,
						isNewMailCapped: model.isNewMailCapped,
						important: model.worth.length,
						moved: isTeam ? null : model.changed.length,
						filed: model.filedTotal,
					}"
					:can-mark-seen="hasAnything && !workbench.isStale.value"
					:inbox-href="inboxHref"
					:compose-href="isTeam ? null : `/compose?mailbox=${scope}`"
					@mark-seen="markAllSeen"
				/>

				<div class="mt-4">
					<TodayAnswerCard
						:items="scopedAnswer"
						:counts="scopedCounts"
						:is-loading="answer.isLoading.value"
						:queue-href="answerHref"
						:inbox-name="scopeName"
					/>
				</div>

				<TodayChanges
					:changes="model.changed"
					:hidden="model.changedHidden"
					:more-href="moreHref"
					@done="doneLine"
				/>

				<div v-if="workbench.isLoading.value && !hasAnything" class="mt-8 space-y-2">
					<UiSkeleton class="h-3 w-24" />
					<UiSkeleton class="h-24 w-full rounded-xl" />
				</div>
				<template v-else>
					<TodayUpdates
						:model="model"
						:more-href="moreHref"
						@done="doneLine"
						@reply-anyway="replyAnyway"
					/>
					<TodayFiledAway :model="model" :scope="scope" />
				</template>
			</div>
		</template>

		<TodayPeekPanel
			:sources="peekSources"
			@close="closePeek"
			@step="(i) => openPeek(peekSources, i)"
			@done="onPeekDone"
		>
			<template #actions="{ source }">
				<UiButton
					v-if="source.kind === 'team'"
					size="sm"
					variant="secondary"
					@click="replyAnywayFromPeek(source)"
				>
					{{ t('components.today.line.replyAnyway') }}
				</UiButton>
			</template>
		</TodayPeekPanel>
	</div>
</template>
