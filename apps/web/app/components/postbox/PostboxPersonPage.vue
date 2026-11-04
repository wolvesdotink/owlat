<script setup lang="ts">
/**
 * One person's page: who they are, what is open between you, the
 * conversations that are current (as topic cards, the ones waiting on you
 * first), and everything earlier as a quiet list that pages further back. A
 * person on a company's domain links to the company page, where their
 * colleagues are. The heading takes focus when the page is opened from the
 * column, and j/k (or the arrow keys) walk the conversations.
 */
import { api } from '@owlat/api';
import {
	olderTopicsKey,
	usePostboxOlderTopics,
	walkTopicCards,
} from '~/composables/postbox/usePostboxPeople';
import type { Id } from '@owlat/api/dataModel';
import {
	CopyIcon,
	MailPlusIcon,
	MoreHorizontalIcon,
	Building2Icon,
	StarIcon,
} from '@coolicons/vue';
import {
	isListedCompany,
	splitTopics,
	type PeopleCompany,
	type PeoplePerson,
	type PeopleSelection,
	type PeopleTopic,
} from '~/utils/postboxPeople';

const props = defineProps<{
	person: PeoplePerson;
	mailboxId: Id<'mailboxes'>;
	topics: ReadonlyMap<string, PeopleTopic>;
	company: PeopleCompany | undefined;
	names: ReadonlyMap<string, string>;
	isShared: boolean;
	pageHref: (target: PeopleSelection) => string;
	topicHref: (topic: PeopleTopic) => string;
}>();

const { t } = useI18n();
const own = computed(() =>
	props.person.topicIds.map((id) => props.topics.get(id)).filter((x): x is PeopleTopic => !!x)
);
const split = computed(() => splitTopics(own.value));
// Whose turn, both ways: what the header says that the cards below do not count.
// Plain text, not a brand mark: the cards carry the status, the header sums it.
// A request Owlat read is a reply owed; a flag without one only may be.
const owedByYou = computed(() => split.value.now.filter((x) => x.isAsk).length);
// What the cards cannot say: who wrote the newest message in view, and when.
const lastMessage = computed(() => {
	const newest = own.value.reduce<PeopleTopic | undefined>(
		(best, x) => (!best || x.lastMessageAt > best.lastMessageAt ? x : best),
		undefined
	);
	if (!newest) return null;
	const when = formatCompactRelativeTime(newest.lastMessageAt);
	return newest.latestFromKey === props.person.key
		? t('components.postbox.people.person.theyWrote', { name: firstName.value, when })
		: newest.turn === 'replied'
			? t('components.postbox.people.person.youWrote', { when })
			: t('components.postbox.people.person.lastMessage', { when });
});
const owedByThem = computed(() => split.value.now.filter((x) => x.turn === 'them').length);
const firstName = computed(() => props.person.name.split(' ')[0] ?? props.person.name);
const composeHref = computed(
	() => `/dashboard/compose?mailbox=${props.mailboxId}&to=${encodeURIComponent(props.person.email)}`
);
const searchHref = computed(
	() =>
		`/dashboard/postbox/search?q=${encodeURIComponent(`from:${props.person.email} OR to:${props.person.email}`)}`
);
const showCompany = computed(() => props.company && isListedCompany(props.company));

// "This is a company account": the owner's per-sender label, through the same
// door as "Recategorize as…" (mail/category.ts), so it is undone the same way.
const lastFromThem = computed(() => own.value.find((x) => x.latestFromKey === props.person.key));
const recategorize = useBackendOperation(api.mail.category.recategorize, {
	label: () => t('components.postbox.people.person.markCompany'),
});
const menuOpen = ref(false);
const { showToast } = useToast();
async function copyAddress() {
	menuOpen.value = false;
	try {
		await navigator.clipboard.writeText(props.person.email);
		showToast(t('dashboard.audience.contacts.index.toasts.emailCopied'), 'success');
	} catch {
		showToast(t('dashboard.audience.contacts.index.toasts.copyFailed'), 'error');
	}
}
async function markAsCompany() {
	menuOpen.value = false;
	const topic = lastFromThem.value;
	if (!topic) return;
	await recategorize.run({ threadId: topic.id as Id<'mailThreads'>, label: 'notification' });
}

// Earlier gets its heading once there is something in it; before, one quiet
// line with the ways further back (PostboxTopicList) is the whole section.
const olderStore = usePostboxOlderTopics();
const hasEarlier = computed(
	() =>
		split.value.earlier.length > 0 ||
		(olderStore.value[olderTopicsKey(props.mailboxId, props.person.email)]?.topics.length ?? 0) > 0
);

const heading = ref<HTMLElement | null>(null);
defineExpose({ focusHeading: () => heading.value?.focus() });
</script>

<template>
	<article class="mx-auto w-full max-w-3xl px-5 pb-16 lg:px-10" @keydown="walkTopicCards">
		<header
			class="flex flex-wrap items-start gap-3 pt-4 pb-4 sm:flex-nowrap sm:gap-5 sm:pt-8 sm:pb-6"
		>
			<PostboxPeopleAvatar
				kind="person"
				:name="person.name"
				:color-key="person.key"
				size="xl"
				class="!hidden sm:!inline-flex"
			/>
			<PostboxPeopleAvatar
				kind="person"
				:name="person.name"
				:color-key="person.key"
				size="md"
				class="mt-0.5 sm:!hidden"
			/>
			<div class="min-w-0 flex-1">
				<h1
					ref="heading"
					tabindex="-1"
					class="flex items-center gap-2 font-display text-2xl leading-tight text-text-primary outline-none sm:text-4xl"
				>
					<span class="break-words sm:truncate">{{ person.name }}</span>
					<StarIcon
						v-if="person.isVip"
						class="h-4 w-4 flex-shrink-0 text-warning"
						:aria-label="t('components.postbox.people.person.vip')"
					/>
				</h1>
				<p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
					<NuxtLink
						v-if="showCompany && company"
						:to="pageHref({ kind: 'company', key: company.key })"
						class="inline-flex min-h-7 items-center gap-1.5 rounded-md bg-bg-surface py-0.5 pl-1 pr-2 text-caption font-medium text-text-primary hover:bg-bg-surface-hover"
					>
						<PostboxPeopleAvatar
							kind="company"
							:name="company.name"
							:logo-url="company.logoUrl"
							size="sm"
						/>
						{{ company.name }}
					</NuxtLink>
					<!-- On a phone the address waits behind the name's tooltip: the
					     conversations come first. -->
					<span class="hidden text-caption text-text-tertiary sm:inline sm:truncate">{{
						person.email
					}}</span>
				</p>
				<p
					class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-text-tertiary sm:mt-2 sm:gap-x-4"
				>
					<span v-if="owedByYou > 0" class="font-medium text-text-secondary">{{
						isShared
							? t('components.postbox.people.person.owedTeam', { count: owedByYou }, owedByYou)
							: t('components.postbox.people.person.owed', { count: owedByYou }, owedByYou)
					}}</span>
					<span v-if="lastMessage">{{ lastMessage }}</span>
					<span v-if="owedByThem > 0">{{
						t(
							'components.postbox.people.person.owedThem',
							{ count: owedByThem, name: firstName },
							owedByThem
						)
					}}</span>
				</p>
			</div>
			<!-- On a phone the actions take their own line so the name and its
			     facts keep the width. -->
			<div
				class="order-last flex basis-full items-center gap-1 pl-12 sm:order-none sm:basis-auto sm:flex-shrink-0 sm:pl-0"
			>
				<UiButton
					:to="composeHref"
					size="sm"
					variant="secondary"
					:aria-label="t('components.postbox.people.person.write', { name: firstName })"
				>
					<MailPlusIcon class="h-3.5 w-3.5" />
					<span class="hidden sm:inline">{{
						t('components.postbox.people.person.write', { name: firstName })
					}}</span>
					<span class="sm:hidden">{{ t('components.postbox.people.person.writeShort') }}</span>
				</UiButton>
				<UiDropdownMenu v-model:open="menuOpen">
					<template #trigger>
						<UiButton
							variant="ghost"
							size="sm"
							:aria-label="t('components.postbox.people.person.more')"
						>
							<MoreHorizontalIcon class="h-4 w-4" />
						</UiButton>
					</template>
					<UiDropdownMenuItem :icon="CopyIcon" @click="copyAddress">
						{{ t('components.postbox.people.person.copyAddress', { address: person.email }) }}
					</UiDropdownMenuItem>
					<UiDropdownMenuItem
						:icon="Building2Icon"
						:disabled="!lastFromThem"
						@click="markAsCompany"
					>
						{{ t('components.postbox.people.person.markCompany') }}
					</UiDropdownMenuItem>
				</UiDropdownMenu>
			</div>
		</header>

		<section :aria-labelledby="`now-${person.key}`">
			<div class="mb-3 flex items-baseline gap-2.5">
				<h2
					:id="`now-${person.key}`"
					class="text-xs font-semibold uppercase tracking-wider text-text-secondary"
				>
					{{ t('components.postbox.people.page.now') }}
				</h2>
				<span class="text-xs tabular-nums text-text-tertiary">{{ split.now.length }}</span>
			</div>
			<div v-if="split.now.length > 0" class="grid gap-2.5">
				<PostboxTopicCard
					v-for="topic in split.now"
					:key="topic.id"
					:topic="topic"
					:to="topicHref(topic)"
					:names="names"
					:page-keys="[person.key]"
					:is-shared="isShared"
				/>
			</div>
			<p v-else class="rounded-xl bg-bg-surface px-4 py-3 text-sm text-text-secondary">
				{{ t('components.postbox.people.person.nothingNow', { name: firstName }) }}
			</p>
		</section>

		<section
			:class="hasEarlier ? 'mt-10' : 'mt-4'"
			:aria-label="t('components.postbox.people.page.earlier')"
		>
			<div v-if="hasEarlier" class="flex items-baseline gap-2.5">
				<h2
					:id="`earlier-${person.key}`"
					class="text-xs font-semibold uppercase tracking-wider text-text-secondary"
				>
					{{ t('components.postbox.people.page.earlier') }}
				</h2>
				<span v-if="split.earlier.length > 0" class="text-xs tabular-nums text-text-tertiary">{{
					split.earlier.length
				}}</span>
			</div>
			<PostboxTopicList
				:topics="split.earlier"
				:shown-elsewhere="split.now.map((x) => x.id)"
				:href-for="topicHref"
				:mailbox-id="mailboxId"
				:older-for="person.email"
				:search-href="searchHref"
				:search-label="t('components.postbox.people.earlier.searchWith', { name: firstName })"
			/>
		</section>
	</article>
</template>
