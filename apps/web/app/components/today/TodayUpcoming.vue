<script setup lang="ts">
/**
 * Today's Upcoming band: everything already set to happen later, in one time
 * order, across every inbox and the workspace's campaigns (today/upcoming.ts).
 * A scheduled send can be sent now, edited or cancelled from its row; the
 * other rows open where they live (the snoozed message, the sent message a
 * reminder watches, the Team Inbox conversation, the campaign).
 *
 * Renders nothing while nothing is scheduled. When more is scheduled than it
 * lists, it offers more, and says so once the page is at its cap.
 */
import { resolveComponent } from 'vue';
import { useTodayUpcoming, type UpcomingSend } from '~/composables/useTodayUpcoming';
import {
	localClockTime,
	upcomingHref,
	upcomingWhen,
	type UpcomingItem,
} from '~/utils/todayUpcoming';

const { t, locale, n } = useI18n();
const { inboxes } = useInboxes();
const upcoming = useTodayUpcoming();
const { items, hasMore, canShowMore, busyKey, error } = upcoming;
const NuxtLink = resolveComponent('NuxtLink');

/** Mailbox names only help when there is more than one inbox to tell apart. */
const showMailbox = computed(() => inboxes.value.length > 1);

// One clock for the band, so "Tomorrow" turns into a time at midnight.
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	tick = setInterval(() => (now.value = Date.now()), 60_000);
});
onBeforeUnmount(() => clearInterval(tick));

function when(item: UpcomingItem): string {
	const w = upcomingWhen(item.at, now.value, locale.value);
	const base = 'components.today.upcoming.when';
	switch (w.kind) {
		case 'now':
			return t(`${base}.now`);
		case 'today':
			return t(`${base}.today`, { time: w.time });
		case 'tomorrow':
			return t(`${base}.tomorrow`, { time: w.time });
		case 'week':
			return t(`${base}.week`, { day: w.day, time: w.time });
		case 'date':
			return t(`${base}.date`, { date: w.date, time: w.time });
	}
}

const ICONS: Record<UpcomingItem['kind'], string> = {
	scheduled_send: 'lucide:send',
	snooze_return: 'lucide:alarm-clock',
	follow_up: 'lucide:bell',
	team_snooze_return: 'lucide:alarm-clock',
	campaign: 'lucide:megaphone',
};

function title(item: UpcomingItem): string {
	const noSubject = t('components.today.upcoming.noSubject');
	if (item.kind === 'campaign')
		return t('components.today.upcoming.campaign.title', { name: item.name });
	return item.subject.trim() || noSubject;
}

function campaignDetail(item: Extract<UpcomingItem, { kind: 'campaign' }>): string {
	const base = 'components.today.upcoming.campaign';
	const parts: string[] = [];
	if (item.audienceName) parts.push(t(`${base}.toAudience`, { audience: item.audienceName }));
	if (item.recipients) {
		parts.push(t(`${base}.recipients`, { count: n(item.recipients.count) }, item.recipients.count));
	}
	if (item.timing === 'recipient_local' && item.localTime) {
		parts.push(t(`${base}.local`, { time: localClockTime(item.localTime, locale.value) }));
	} else if (item.timing === 'optimized') {
		parts.push(t(`${base}.optimized`));
	}
	return parts.join(' · ');
}

function detail(item: UpcomingItem): string {
	const base = 'components.today.upcoming';
	switch (item.kind) {
		case 'scheduled_send': {
			if (!item.firstRecipient) return t(`${base}.send.noRecipient`);
			const others = item.recipientCount - 1;
			return others > 0
				? t(`${base}.send.toMany`, { to: item.firstRecipient, count: others }, others)
				: t(`${base}.send.to`, { to: item.firstRecipient });
		}
		case 'snooze_return':
			return t(item.isUntilReply ? `${base}.snooze.untilReply` : `${base}.snooze.returns`, {
				from: item.from,
			});
		case 'follow_up':
			return item.waitingOn
				? t(`${base}.followUp.waitingOn`, { who: item.waitingOn })
				: t(`${base}.followUp.anyone`);
		case 'team_snooze_return':
			return t(`${base}.teamSnooze`, { contact: item.contact });
		case 'campaign':
			return campaignDetail(item);
	}
}

function countedTitle(item: UpcomingItem): string | undefined {
	if (item.kind !== 'campaign' || !item.recipients) return undefined;
	const at = new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' });
	return t('components.today.upcoming.campaign.countedAt', {
		when: at.format(item.recipients.countedAt),
	});
}

function mailboxOf(item: UpcomingItem): string | null {
	return 'mailboxLabel' in item && showMailbox.value ? item.mailboxLabel : null;
}

const asSend = (item: UpcomingItem) => item as UpcomingSend;
</script>

<template>
	<section
		v-if="items.length > 0 || error"
		aria-labelledby="today-upcoming"
		data-testid="today-upcoming"
		class="mt-10"
	>
		<h2
			id="today-upcoming"
			class="mb-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{ t('components.today.upcoming.title') }}
		</h2>
		<UiQueryBoundary
			v-if="error && items.length === 0"
			:error="error"
			:error-title="t('components.today.upcoming.loadFailed')"
			@retry="upcoming.refetch"
		/>
		<ul
			v-else
			class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
		>
			<li
				v-for="item in items"
				:key="item.key"
				class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap"
				:data-upcoming-kind="item.kind"
			>
				<span
					class="basis-full text-xs tabular-nums text-text-secondary sm:w-28 sm:shrink-0 sm:basis-auto"
					data-testid="today-upcoming-when"
					>{{ when(item) }}</span
				>
				<Icon
					:name="ICONS[item.kind]"
					class="size-4 shrink-0 text-text-tertiary"
					aria-hidden="true"
				/>
				<component
					:is="upcomingHref(item) ? NuxtLink : 'span'"
					:to="upcomingHref(item) ?? undefined"
					class="min-w-0 flex-1"
					:class="upcomingHref(item) ? 'rounded-sm hover:text-brand' : ''"
					:title="countedTitle(item)"
				>
					<span class="flex min-w-0 items-center gap-1.5">
						<span class="truncate text-sm font-medium text-text-primary">{{ title(item) }}</span>
						<span
							v-if="mailboxOf(item)"
							class="shrink-0 rounded-full bg-bg-surface px-1.5 text-2xs font-medium text-text-secondary"
							>{{ mailboxOf(item) }}</span
						>
					</span>
					<span class="block truncate text-xs text-text-tertiary">{{ detail(item) }}</span>
				</component>
				<span
					v-if="item.kind === 'scheduled_send'"
					class="flex basis-full items-center gap-1.5 pl-7 sm:shrink-0 sm:basis-auto sm:pl-0"
					:aria-label="t('components.today.upcoming.actionsFor', { subject: title(item) })"
					role="group"
				>
					<UiButton
						size="sm"
						variant="secondary"
						:disabled="busyKey !== null"
						:loading="busyKey === item.key"
						@click="upcoming.sendNow(asSend(item))"
					>
						{{ t('components.today.upcoming.actions.sendNow') }}
					</UiButton>
					<UiButton
						size="sm"
						variant="ghost"
						:disabled="busyKey !== null"
						@click="upcoming.edit(asSend(item))"
					>
						{{ t('components.today.upcoming.actions.edit') }}
					</UiButton>
					<UiButton
						size="sm"
						variant="ghost"
						:disabled="busyKey !== null"
						@click="upcoming.cancel(asSend(item))"
					>
						{{ t('components.today.upcoming.actions.cancel') }}
					</UiButton>
				</span>
			</li>
		</ul>
		<div
			v-if="hasMore && items.length > 0"
			class="mt-2 text-xs text-text-tertiary"
			data-testid="today-upcoming-more"
		>
			<UiButton v-if="canShowMore" size="sm" variant="ghost" @click="upcoming.showMore()">
				{{ t('components.today.upcoming.showMore') }}
			</UiButton>
			<p v-else>{{ t('components.today.upcoming.moreThanShown') }}</p>
		</div>
	</section>
</template>
