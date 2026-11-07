<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { answerCounts } from '~/composables/useAnswerQueue';
import { answerItemMatches } from '~/utils/answerQueue';
import { ALL_INBOXES_PATH, allInboxesHref } from '~/utils/postboxAllInboxes';
import { useWorkbenchWork } from '~/composables/useWorkbenchWork';
import { useWorkbenchLineActions } from '~/composables/useWorkbenchLineActions';
import { useWorkbenchKeyboard } from '~/composables/useWorkbenchKeyboard';
import { useZenMode } from '~/composables/useZenMode';
import { useWorkbenchDwell } from '~/composables/useWorkbenchDwell';
import type { TodayChange, TodayLine, TodaySource } from '~/utils/todayDigest';
import { TODAY_PEEK, peekKey, threadHref } from '~/utils/todayPeek';
import {
	ALL_SCOPE,
	TEAM_SCOPE,
	WORKBENCH_SCOPE_STORAGE_KEY,
	pickWorkbenchScope,
	workbenchTabs,
	type WorkbenchScope,
	type WorkbenchTab,
} from '~/utils/workbench';
import { CircleWarningIcon, InboxIcon, MentionIcon } from '@coolicons/vue';

/**
 * The Workbench — the home screen. Everything that arrives either tells you
 * something or asks something of you, so it answers two questions side by
 * side, across every inbox at once (the All tab, the default) or narrowed to
 * one inbox's tab:
 *
 *   - What needs you: one list of work, whatever it arrived as (a reply the
 *     Answer queue holds, a request that needs no reply, a task), each card
 *     with its next step on it (TodayWork);
 *   - To acknowledge: what moved in the conversations you already know, what
 *     you should know (important updates, one sentence each, then routine
 *     mail), and what was filed away. "Got it" on a line acknowledges it; any
 *     line can still become a task or get a reply.
 *
 * Every summarised phrase links, quietly, to the email it came from.
 *
 * Each inbox tab has its own "since you last looked" watermark; All reads the
 * global one, so marking All as seen catches every tab up. A watermark only
 * moves on purpose: "Mark as seen", finishing the Answer queue, or a
 * deliberate stay on a tab of at least half a minute before leaving.
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
const inboxRead = useInboxes();
const { inboxes, byId, isLoading: inboxesLoading } = inboxRead;
const answer = useAnswerQueue();
const choice = useWorkbenchInboxChoice();
const { level: deliveryLevel, reason: deliveryReason } = useDeliveryHealth();
const { showToast } = useToast();
const { isZen, exitZen } = useZenMode();

// ── Which tab ──────────────────────────────────────────────────────────────
const teamOn = computed(() => isAdmin.value && isEnabled('inbox'));
const remembered = ref<string | null>(null);
onMounted(() => {
	remembered.value = localStorage.getItem(WORKBENCH_SCOPE_STORAGE_KEY);
});
const inboxScopes = computed<WorkbenchScope[]>(() => [
	...inboxes.value.map((i) => i.mailboxId as string),
	...(teamOn.value ? [TEAM_SCOPE] : []),
]);
// All combines what there is to combine: with one inbox it is that inbox.
const allScopes = computed<WorkbenchScope[]>(() =>
	inboxScopes.value.length > 1 ? [ALL_SCOPE, ...inboxScopes.value] : inboxScopes.value
);
const shownScopes = computed(() => {
	const hidden = new Set<string>(choice.hiddenMailboxIds.value);
	return allScopes.value.filter((s) => !hidden.has(s));
});
/** The mailboxes All combines: the ones the viewer did not leave out of the Workbench. */
const shownMailboxIds = computed(
	() => shownScopes.value.filter((s) => s !== ALL_SCOPE && s !== TEAM_SCOPE) as Id<'mailboxes'>[]
);
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
const isAll = computed(() => scope.value === ALL_SCOPE);
const inbox = computed(() =>
	scope.value && !isTeam.value && !isAll.value
		? (byId.value.get(scope.value as Id<'mailboxes'>) ?? null)
		: null
);
const scopeName = computed(() =>
	isAll.value
		? t('dashboard.today.allInboxes')
		: isTeam.value
			? t('components.shell.teamInbox')
			: (inbox.value?.name ?? '')
);
useHead({
	title: () =>
		scopeName.value
			? `${scopeName.value} · ${t('dashboard.today.pageTitle')}`
			: t('dashboard.today.pageTitle'),
});

const tabs = computed<WorkbenchTab[]>(() =>
	workbenchTabs({
		inboxIds: inboxScopes.value.filter((s) => s !== TEAM_SCOPE),
		hidden: choice.hiddenMailboxIds.value,
		teamOn: teamOn.value,
		current: scope.value,
	}).map((s) => {
		const identity =
			s === TEAM_SCOPE || s === ALL_SCOPE ? null : byId.value.get(s as Id<'mailboxes'>);
		return {
			scope: s,
			name:
				s === ALL_SCOPE
					? t('dashboard.today.allInboxes')
					: (identity?.name ?? t('components.shell.teamInbox')),
			slot: identity?.slot ?? null,
			address: identity?.address ?? null,
			isTeam: s === TEAM_SCOPE,
			answer: answer.items.value.filter((item) => answerItemMatches(item, s)).length,
			unread:
				s === ALL_SCOPE
					? inboxes.value.reduce((sum, i) => sum + (i.unread ?? 0), 0)
					: (identity?.unread ?? 0),
		};
	})
);

// ── This tab ───────────────────────────────────────────────────────────────
const workbench = useWorkbench(scope, shownMailboxIds);
const scopedAnswer = computed(() =>
	scope.value ? answer.items.value.filter((item) => answerItemMatches(item, scope.value!)) : []
);
const scopedCounts = computed(() => answerCounts(scopedAnswer.value));
const { myTasks, scopedTasks, scopedTodo, workCount } = useWorkbenchWork({
	scope,
	inbox,
	shownMailboxIds,
	answer: scopedAnswer,
});
const mentions = computed(() => answer.counts.value.mention);
const answerHref = computed(() =>
	scope.value ? `/dashboard/answer?in=${encodeURIComponent(scope.value)}` : '/dashboard/answer'
);
const inboxHref = computed(() =>
	isAll.value
		? ALL_INBOXES_PATH
		: isTeam.value
			? '/dashboard/inbox'
			: `/dashboard/postbox/inbox?mailbox=${scope.value}`
);
const moreHref = computed(() =>
	isAll.value
		? ALL_INBOXES_PATH
		: isTeam.value
			? '/dashboard/inbox'
			: allInboxesHref({ in: scope.value })
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

const { sinceLabel } = workbench;
const ackCount = computed(
	() => model.value.changed.length + model.value.worth.length + model.value.also.length
);

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
useWorkbenchDwell({
	scope,
	showing: computed(() => hasAnything.value && !workbench.isStale.value && !isZen.value),
	asOf: workbench.asOf,
	markSeen: (tab, at) => void workbench.markSeen(tab, at),
});
watch(scope, () => (hidden.value = new Set()));

// ── Actions on lines ────────────────────────────────────────────────────────
const { doneLine, replyAnyway } = useWorkbenchLineActions(hidden);

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
	if (line) void replyAnyway(line, { answer: source });
}

// ── Keyboard: j/k between lines, Enter opens, d done, r reply anyway ───────
useWorkbenchKeyboard({
	lines: () => (isZen.value ? [] : allLines.value),
	peekOpen: () => !!route.query['peek'],
	open: (line) => openPeek(line.sources),
	done: (line) => void doneLine(line),
	replyAnyway: (line) => void replyAnyway(line),
});
</script>

<template>
	<div class="mx-auto w-full max-w-4xl px-6 pb-16 pt-8 lg:px-10 xl:max-w-page">
		<!-- One reading column up to xl; from there the page grows to the shared
		     page cap and the lanes sit side by side. -->
		<header v-if="!isZen">
			<UiPageHeader>
				<template #title>
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
				</template>
			</UiPageHeader>
		</header>

		<!-- Only when something is actually broken, and only for admins. -->
		<div class="mt-6 space-y-3 empty:hidden">
			<NuxtLink
				v-if="isAdmin && deliveryLevel === 'error'"
				to="/dashboard/admin/delivery"
				class="flex items-center gap-2 rounded-xl border border-error/30 bg-error-subtle px-4 py-2.5 text-sm text-error"
			>
				<CircleWarningIcon class="size-4" />
				<span class="flex-1">{{ deliveryReason || t('dashboard.today.deliveryAlert') }}</span>
				<span class="text-xs underline">{{ t('dashboard.today.openDelivery') }}</span>
			</NuxtLink>
			<DashboardAccessRequests v-if="hasActiveOrganization && isAdmin" />
			<DashboardMailboxRequests v-if="hasActiveOrganization && isAdmin" />
			<DashboardGettingStarted
				v-if="hasActiveOrganization && userId && !isZen"
				:user-id="userId"
				:is-admin="isAdmin"
				compact
			/>
		</div>

		<div v-if="inboxesLoading && tabs.length === 0" class="mt-8 space-y-3">
			<UiSkeleton class="h-9 w-80" />
			<UiSkeleton class="h-36 w-full rounded-2xl" />
		</div>

		<UiQueryBoundary
			v-else-if="inboxRead.error.value && tabs.length === 0"
			:error="inboxRead.error.value"
			@retry="inboxRead.refetch"
		/>
		<!-- No inbox to work from yet (a failed read is not that). -->
		<div
			v-else-if="scope === null"
			class="mt-8 flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border-subtle px-6 py-8"
		>
			<InboxIcon class="size-6 text-text-tertiary" />
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
				v-if="!isZen"
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
						<MentionIcon class="size-3" />
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
				v-bind="isZen ? {} : { role: 'tabpanel', 'aria-labelledby': `workbench-tab-${scope}` }"
				class="pt-6"
			>
				<TodayScopeHeader
					v-if="!isZen"
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
					:compose-href="isTeam ? null : isAll ? '/compose' : `/compose?mailbox=${scope}`"
					@mark-seen="markAllSeen"
				/>

				<!-- Two lanes, one question each: what do I owe, and what should I
				     know. Below xl they stack, "To do" first. -->
				<div class="mt-6 xl:grid xl:grid-cols-2 xl:items-start xl:gap-x-10">
					<TodayLane
						id="workbench-lane-do"
						:title="t('dashboard.today.lanes.do.title')"
						:hint="t('dashboard.today.lanes.do.hint')"
						:count="workCount"
						data-workbench-lane="do"
					>
						<h1 v-if="isZen" class="mb-3 text-sm font-medium text-text-secondary">
							{{ scopeName }}
						</h1>
						<!-- Zen keeps only what needs an answer. -->
						<TodayWork
							:answer="scopedAnswer"
							:todo="isZen ? [] : scopedTodo"
							:tasks="isZen ? [] : scopedTasks"
							:counts="scopedCounts"
							:is-loading="answer.isLoading.value || myTasks.isLoading.value"
							:queue-href="answerHref"
							:show-inbox="isAll"
						/>
					</TodayLane>

					<TodayLane
						id="workbench-lane-ack"
						:title="t('dashboard.today.lanes.acknowledge.title')"
						:hint="t('dashboard.today.lanes.acknowledge.hint')"
						:count="ackCount"
						class="mt-12 xl:mt-0"
						data-workbench-lane="acknowledge"
					>
						<!-- Zen keeps only what needs an answer (and says what it left out). -->
						<TodayZenMore
							v-if="isZen"
							:inbox-name="scopeName"
							:count="allLines.length"
							@show="exitZen"
						/>
						<template v-else>
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
							<TodayUpdates
								v-else
								:model="model"
								:more-href="moreHref"
								@done="doneLine"
								@reply-anyway="replyAnyway"
							/>
							<TodayFiledAway
								v-if="!(workbench.isLoading.value && !hasAnything)"
								:model="model"
								:scope="scope"
							/>
						</template>
					</TodayLane>
				</div>
			</div>
		</template>

		<!-- Across every inbox and campaigns, so it also shows with no inbox. -->
		<TodayUpcoming v-if="hasActiveOrganization && !isZen" />

		<TodayPeekPanel
			:sources="peekSources"
			@close="closePeek"
			@step="(i) => openPeek(peekSources, i)"
			@done="onPeekDone"
		>
			<template #actions="{ source, informational }">
				<UiButton
					v-if="source.kind === 'team' && informational"
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
