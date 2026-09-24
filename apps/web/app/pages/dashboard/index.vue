<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { TodayChange, TodayLine, TodaySource } from '~/utils/todayDigest';
import { TODAY_PEEK, peekKey, threadHref } from '~/utils/todayPeek';

/**
 * Today — the home screen. It answers three questions in this order: does
 * anything need me (and one button into the Answer queue), what moved in the
 * conversations I already know, and what should I know (the updates digest
 * that replaced the separate Updates page). Every summarised phrase links,
 * quietly, to the email it came from.
 *
 * The "since you last looked" watermark only moves on purpose: "Mark all as
 * seen", finishing the Answer queue, or a deliberate stay here of at least
 * half a minute before leaving.
 */
const { t } = useI18n();
useHead({ title: () => t('dashboard.today.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

const { user } = useAuth();
const { hasActiveOrganization } = useOrganizationContext();
// The team-inbox lines (and their Done / Reply anyway) exist for admins only.
const { isAdmin } = usePermissions();
const userId = computed(() => user.value?.id ?? null);
const firstName = computed(() => user.value?.name?.split(' ')[0] ?? '');

const today = useToday();
// Inboxes left out of Today drop out of its answer card too; the Answer queue
// itself still lists them.
const answer = useAnswerQueue({ hiddenMailboxIds: today.hiddenMailboxIds });
const { count: answerQueueTotal } = useAnswerQueue();
const { inboxes } = useInboxes();
const { level: deliveryLevel, reason: deliveryReason } = useDeliveryHealth();
const { showToast } = useToast();

// ── Greeting + "since" line ────────────────────────────────────────────────
const hour = new Date().getHours();
const greetingKey = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

const sinceLabel = computed(() => {
	const at = today.since.value;
	if (at === undefined) return '';
	const date = new Date(at);
	const sameDay = date.toDateString() === new Date().toDateString();
	return new Intl.DateTimeFormat(undefined, {
		...(sameDay ? {} : { weekday: 'long' }),
		hour: 'numeric',
		minute: '2-digit',
	}).format(date);
});

// Local hides so Done / Reply anyway feel instant; the live read confirms.
const hidden = ref(new Set<string>());
const model = computed(() => {
	const m = today.model.value;
	const keep = <T extends { key: string }>(list: readonly T[]) =>
		list.filter((l) => !hidden.value.has(l.key));
	return { ...m, changed: keep(m.changed), worth: keep(m.worth), also: keep(m.also) };
});

const summaryParts = computed(() => {
	const m = model.value;
	const parts: string[] = [];
	parts.push(
		m.isNewMailCapped
			? t('dashboard.today.since.newMailCapped', { count: m.newMail })
			: t('dashboard.today.since.newMail', { count: m.newMail }, m.newMail)
	);
	if (m.changed.length > 0)
		parts.push(t('dashboard.today.since.moved', { count: m.changed.length }, m.changed.length));
	if (answer.counts.value.mention > 0) {
		parts.push(
			t(
				'dashboard.today.since.mentions',
				{ count: answer.counts.value.mention },
				answer.counts.value.mention
			)
		);
	}
	return parts;
});

const hasAnything = computed(
	() =>
		model.value.changed.length > 0 ||
		model.value.worth.length > 0 ||
		model.value.also.length > 0 ||
		model.value.newMail > 0
);

// ── Mark all as seen (with undo) + the deliberate-dwell rule ────────────────
async function markAllSeen() {
	const result = await today.markSeen();
	if (!result.ok) return;
	hidden.value = new Set();
	showToast(t('dashboard.today.markedSeen'), 'success', {
		action: { label: t('common.undo'), onAction: () => void today.undoMarkSeen() },
	});
}
const DWELL_MS = 30_000;
const mountedAt = Date.now();
onBeforeUnmount(() => {
	if (Date.now() - mountedAt >= DWELL_MS && hasAnything.value) void today.markSeen();
});

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
	if (!ok) {
		const next = new Set(hidden.value);
		next.delete(line.key);
		hidden.value = next;
	}
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
				onAction: () => void navigateTo('/dashboard/answer'),
			},
		});
	} else {
		const next = new Set(hidden.value);
		next.delete(line.key);
		hidden.value = next;
	}
}

// ── Peek panel (state in the URL) ───────────────────────────────────────────
const route = useRoute();
const router = useRouter();
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
function onPeekDone(source: TodaySource) {
	const line = [...model.value.changed, ...model.value.worth, ...model.value.also].find((l) =>
		l.sources.some((s) => s.id === source.id)
	);
	closePeek();
	if (line) void doneLine(line);
}

// ── Keyboard: j/k between lines, Enter opens, d done, r reply anyway ───────
function lines(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>('[data-today-key]'));
}
function onKeydown(event: KeyboardEvent) {
	if (route.query['peek'] || event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	const all = lines();
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
	const key = active.dataset['todayKey'];
	const line = [...model.value.changed, ...model.value.worth, ...model.value.also].find(
		(l) => l.key === key
	);
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
		<!-- Greeting + what happened since the viewer last looked -->
		<header class="flex flex-wrap items-start gap-4">
			<div class="min-w-0 flex-1">
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
				<p v-if="today.since.value !== undefined" class="mt-1.5 text-sm text-text-secondary">
					{{
						today.isFallback.value
							? t('dashboard.today.since.fallback')
							: t('dashboard.today.since.label', { when: sinceLabel })
					}}
					<span class="text-text-primary">{{ summaryParts.join(', ') }}.</span>
				</p>
				<UiSkeleton v-else class="mt-2 h-4 w-80" />
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<TodayInboxPicker
					v-if="inboxes.length > 1"
					:inboxes="inboxes"
					:hidden="today.hiddenMailboxIds.value"
					@toggle="today.setInboxShown"
				/>
				<UiButton v-if="hasAnything" variant="secondary" size="sm" @click="markAllSeen">
					<template #iconLeft><Icon name="lucide:check-check" class="size-4" /></template>
					{{ t('dashboard.today.markAllSeen') }}
				</UiButton>
			</div>
		</header>

		<!-- Only when something is actually broken, and only for admins. -->
		<div class="mt-6 space-y-3">
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

		<div class="mt-2">
			<TodayAnswerCard
				:items="answer.items.value"
				:counts="answer.counts.value"
				:is-loading="answer.isLoading.value"
				:queue-total="answerQueueTotal"
			/>
		</div>

		<TodayChanges :changes="model.changed" :hidden="model.changedHidden" @done="doneLine" />

		<div v-if="today.isLoading.value && !hasAnything" class="mt-8 space-y-2">
			<UiSkeleton class="h-3 w-24" />
			<UiSkeleton class="h-24 w-full rounded-xl" />
		</div>
		<TodayUpdates
			v-else
			:model="model"
			:team-on="today.teamOn.value"
			@done="doneLine"
			@reply-anyway="replyAnyway"
		/>

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
					@click="
						() => {
							const line = model.worth
								.concat(model.also)
								.find((l) => l.inboundMessageId === source.id);
							closePeek();
							if (line) void replyAnyway(line);
						}
					"
				>
					{{ t('components.today.line.replyAnyway') }}
				</UiButton>
			</template>
		</TodayPeekPanel>
	</div>
</template>
