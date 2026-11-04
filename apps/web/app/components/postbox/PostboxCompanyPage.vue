<script setup lang="ts">
/**
 * One company's page. Two kinds of mail meet here and are kept apart on
 * purpose: the conversations you have with the people who work there (topic
 * cards, then their earlier ones, each tagged with who it was with), and what
 * the company's systems send (receipts, notifications, newsletters), which is
 * not a conversation and reads as a quiet list. Its people sit under the name
 * as a strip of links to their own pages.
 *
 * The labels describe what they are about: "Company" for a company with people
 * in it, "Company account" only for one that is nothing but system senders,
 * and the kind (Receipts, Newsletter) for those senders' mail.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	ArchiveIcon,
	Building2Icon,
	ShieldCheckIcon,
	MoreHorizontalIcon,
	UserIcon,
	BellIcon,
} from '@coolicons/vue';
import { walkTopicCards } from '~/composables/postbox/usePostboxPeople';
import {
	splitTopics,
	type PeopleAccount,
	type PeopleCompany,
	type PeoplePerson,
	type PeopleSelection,
	type PeopleTopic,
} from '~/utils/postboxPeople';

const props = defineProps<{
	company: PeopleCompany;
	mailboxId: Id<'mailboxes'>;
	topics: ReadonlyMap<string, PeopleTopic>;
	people: ReadonlyMap<string, PeoplePerson>;
	accounts: ReadonlyMap<string, PeopleAccount>;
	names: ReadonlyMap<string, string>;
	isShared: boolean;
	pageHref: (target: PeopleSelection) => string;
	topicHref: (topic: PeopleTopic) => string;
}>();

const { t } = useI18n();
const members = computed(() =>
	props.company.personKeys
		.map((k) => props.people.get(k))
		.filter((p): p is PeoplePerson => !!p)
		.sort((a, b) => b.owedCount - a.owedCount || b.lastAt - a.lastAt)
);
const systems = computed(() =>
	props.company.accountKeys.map((k) => props.accounts.get(k)).filter((a): a is PeopleAccount => !!a)
);
// A department address (billing@ answered by people) is someone to talk to;
// only a machine's mail is a list of updates.
const departments = computed(() => systems.value.filter((a) => !a.isAutomated));
const machines = computed(() => systems.value.filter((a) => a.isAutomated));
const memberKeys = computed(
	() => new Set([...props.company.personKeys, ...departments.value.map((a) => a.key)])
);
const accountKeys = computed(() => new Set(machines.value.map((a) => a.key)));
const topicsOf = (keys: ReadonlySet<string>) =>
	props.company.topicIds
		.map((id) => props.topics.get(id))
		.filter((x): x is PeopleTopic => !!x && x.partyKeys.some((k) => keys.has(k)));

const conversations = computed(() => splitTopics(topicsOf(memberKeys.value)));
// A company with many people can have dozens of open conversations; the first
// few (ours first) are what the page is for, the rest wait behind one button.
const NOW_CAP = 5;
const showAllNow = ref(false);
watch(
	() => props.company.key,
	() => (showAllNow.value = false)
);
const shownNow = computed(() =>
	showAllNow.value ? conversations.value.now : conversations.value.now.slice(0, NOW_CAP)
);
const hiddenNow = computed(() => conversations.value.now.length - shownNow.value.length);
const updates = computed(() =>
	topicsOf(accountKeys.value).filter((x) => !x.partyKeys.some((k) => memberKeys.value.has(k)))
);
// A system mail that still asks something of you (a payment due) is a card, not a row.
const dueUpdates = computed(() => updates.value.filter((x) => x.openItem?.isOurs));
const quietUpdates = computed(() => updates.value.filter((x) => !x.openItem?.isOurs));
// What "Archive N updates" moves: the ones still in the inbox.
const archivable = computed(() => quietUpdates.value.filter((x) => !x.isArchived));

const searchHref = computed(() =>
	props.company.domain
		? `/dashboard/postbox/search?q=${encodeURIComponent(`from:${props.company.domain} OR to:${props.company.domain}`)}`
		: undefined
);

// Company cards name who each conversation is with, apart from its words.
const bylineFor = (topic: PeopleTopic) => {
	const key = topic.partyKeys.find((k) => memberKeys.value.has(k));
	const name = key ? (props.people.get(key)?.name ?? props.names.get(key)) : undefined;
	return name ? t('components.postbox.people.column.withWhom', { name }) : undefined;
};
const whoFor = (topic: PeopleTopic) => {
	const key = topic.partyKeys.find((k) => memberKeys.value.has(k));
	return key ? props.names.get(key) : undefined;
};
const kindFor = (topic: PeopleTopic) =>
	topic.category && topic.category !== 'person' && topic.category !== 'other'
		? t(`components.postbox.people.kind.${topic.category}`)
		: undefined;

const recategorize = useBackendOperation(api.mail.category.recategorize, {
	label: () => t('components.postbox.people.company.markPerson'),
});
const menuOpen = ref(false);
async function markAsPerson(account: PeopleAccount) {
	menuOpen.value = false;
	const topic = account.topicIds
		.map((id) => props.topics.get(id))
		.find((x) => x?.latestFromKey === account.key);
	if (!topic) return;
	await recategorize.run({ threadId: topic.id as Id<'mailThreads'>, label: 'person' });
}

// How often a sender writes, from its mail in view: worth knowing before muting it.
const cadence = computed(() => {
	if (!props.company.isAutomated) return null;
	const times = updates.value.map((x) => x.lastMessageAt).sort((a, b) => a - b);
	// Fewer than three letters say nothing about a rhythm, so say nothing. The
	// span runs to now: a sender that went quiet a month ago is no longer weekly.
	if (times.length < 3) return null;
	const days = (Date.now() - times[0]!) / times.length / 86_400_000;
	if (days < 2) return t('components.postbox.people.company.cadenceDaily');
	if (days < 12) return t('components.postbox.people.company.cadenceWeekly');
	return days < 45
		? t('components.postbox.people.company.cadenceMonthly')
		: t('components.postbox.people.company.cadenceRare');
});

// Archive the sender's updates listed here (not the ones still asking for
// something), with the Postbox's own undo; the label says how many.
const archiveOp = useBackendOperation(api.mail.threadArchive.archiveThreads, {
	label: () => t('components.postbox.people.company.archiveOperation'),
});
const moveOp = useBackendOperation(api.mail.messageActions.move, {
	label: () => t('components.postbox.people.company.archiveOperation'),
});
const triageUndo = usePostboxTriageUndo();
async function archiveAll() {
	const ids = archivable.value.map((x) => ({ threadId: x.id as Id<'mailThreads'> }));
	const moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }> = [];
	// The server takes a hundred conversations a call; walk them in calls of that size.
	for (let i = 0; i < ids.length; i += 100) {
		const result = await archiveOp.run({ threads: ids.slice(i, i + 100) });
		if (!result.ok) break;
		moved.push(...(result.result?.moved ?? []));
	}
	triageUndo.registerMoveBack({
		label: t(
			'components.postbox.people.company.archivedUpdates',
			{ count: ids.length, name: props.company.name },
			ids.length
		),
		kind: 'archived',
		moved,
		runMove: (args) => moveOp.run(args),
	});
}

const heading = ref<HTMLElement | null>(null);
defineExpose({ focusHeading: () => heading.value?.focus() });
</script>

<template>
	<article class="mx-auto w-full max-w-3xl px-5 pb-16 lg:px-10" @keydown="walkTopicCards">
		<header
			class="flex flex-wrap items-start gap-4 pt-5 pb-5 sm:flex-nowrap sm:gap-5 sm:pt-8 sm:pb-6"
		>
			<PostboxPeopleAvatar
				kind="company"
				:name="company.name"
				:logo-url="company.logoUrl"
				:is-automated="company.isAutomated"
				:sender-kind="company.kind"
				:size="company.isAutomated ? 'lg' : 'xl'"
				class="!hidden sm:!inline-flex"
			/>
			<PostboxPeopleAvatar
				kind="company"
				:name="company.name"
				:logo-url="company.logoUrl"
				:is-automated="company.isAutomated"
				:sender-kind="company.kind"
				size="lg"
				class="sm:!hidden"
			/>
			<div class="min-w-0 flex-1">
				<h1
					ref="heading"
					tabindex="-1"
					:class="company.isAutomated ? 'text-2xl sm:text-3xl' : 'text-3xl sm:text-4xl'"
					class="truncate font-display leading-tight text-text-primary outline-none"
				>
					{{ company.name }}
				</h1>
				<p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
					<span
						class="inline-flex items-center gap-1 rounded-md bg-bg-surface px-2 py-0.5 text-2xs font-semibold text-text-secondary ring-1 ring-inset ring-border-default"
					>
						<component :is="company.isAutomated ? BellIcon : Building2Icon" class="h-3 w-3" />
						{{
							company.isAutomated
								? t('components.postbox.people.company.account')
								: t('components.postbox.people.company.company')
						}}
					</span>
					<span v-if="company.domain" class="text-text-tertiary">{{ company.domain }}</span>
					<span v-if="cadence" class="text-text-tertiary">{{ cadence }}</span>
					<span
						v-if="company.logoUrl"
						class="inline-flex items-center gap-1 text-text-tertiary"
						:title="t('components.postbox.people.company.verifiedHelp')"
					>
						<ShieldCheckIcon class="h-3.5 w-3.5 text-success" />
						{{ t('components.postbox.people.company.verified') }}
					</span>
				</p>
				<ul
					v-if="members.length + departments.length > 0"
					class="mt-3 flex flex-wrap gap-1.5"
					:aria-label="t('components.postbox.people.company.peopleAt', { name: company.name })"
				>
					<li v-for="member in members" :key="member.key">
						<NuxtLink
							:to="pageHref({ kind: 'person', key: member.key })"
							class="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-bg-overlay py-0.5 pl-0.5 pr-2.5 text-caption font-medium text-text-primary shadow-surface-2 outline-none hover:shadow-surface-3 focus-visible:ring-2 focus-visible:ring-brand/40"
						>
							<PostboxPeopleAvatar
								kind="person"
								:name="member.name"
								:color-key="member.key"
								size="sm"
							/>
							{{ member.name }}
							<PostboxPeopleMark
								:owed="member.owedCount"
								:may-owe="member.mayOweCount"
								:unread="member.unread"
								size="sm"
							/>
						</NuxtLink>
					</li>
					<!-- A department has no page of its own (its mail is on this one), so it
					     reads as a label, not as a chip that looks like a link. -->
					<li
						v-for="account in departments"
						:key="account.key"
						class="inline-flex min-h-8 items-center gap-1 px-1 text-caption text-text-tertiary"
						:title="account.email"
					>
						<Building2Icon class="h-3.5 w-3.5" />
						{{ account.email }}
					</li>
				</ul>
			</div>
			<!-- Below the name on a phone, so the name keeps its width. -->
			<div
				v-if="company.isAutomated"
				class="order-last flex basis-full items-center gap-1 sm:order-none sm:basis-auto sm:flex-shrink-0"
			>
				<UiButton
					v-if="archivable.length > 0"
					variant="secondary"
					size="sm"
					:loading="archiveOp.isLoading.value"
					:aria-label="
						t(
							'components.postbox.people.company.archiveUpdates',
							{ count: archivable.length },
							archivable.length
						)
					"
					@click="archiveAll"
				>
					<ArchiveIcon class="h-3.5 w-3.5" />
					<span class="hidden sm:inline">{{
						t(
							'components.postbox.people.company.archiveUpdates',
							{ count: archivable.length },
							archivable.length
						)
					}}</span>
				</UiButton>
				<UiButton variant="secondary" size="sm" to="/dashboard/postbox/senders">
					{{ t('components.postbox.people.company.senderSettings') }}
				</UiButton>
			</div>
			<UiDropdownMenu v-if="systems.length > 0" v-model:open="menuOpen">
				<template #trigger>
					<UiButton
						variant="ghost"
						size="sm"
						:aria-label="t('components.postbox.people.person.more')"
					>
						<MoreHorizontalIcon class="h-4 w-4" />
					</UiButton>
				</template>
				<UiDropdownMenuItem
					v-for="account in systems"
					:key="account.key"
					:icon="UserIcon"
					@click="markAsPerson(account)"
				>
					{{ t('components.postbox.people.company.isPerson', { address: account.email }) }}
				</UiDropdownMenuItem>
			</UiDropdownMenu>
		</header>

		<section
			v-if="dueUpdates.length > 0"
			class="mb-8 grid gap-2.5"
			:aria-label="t('components.postbox.people.company.needsYou')"
		>
			<PostboxTopicCard
				v-for="topic in dueUpdates"
				:key="topic.id"
				:topic="topic"
				:to="topicHref(topic)"
				:names="names"
				:page-keys="company.accountKeys"
				:is-shared="isShared"
				is-system-mail
			/>
		</section>

		<section v-if="!company.isAutomated" :aria-labelledby="`conv-${company.key}`">
			<div class="mb-3 flex items-baseline gap-2.5">
				<h2
					:id="`conv-${company.key}`"
					class="text-xs font-semibold uppercase tracking-wider text-text-secondary"
				>
					{{ t('components.postbox.people.page.now') }}
				</h2>
				<span class="text-xs tabular-nums text-text-tertiary">{{ conversations.now.length }}</span>
			</div>
			<div v-if="conversations.now.length > 0" class="grid gap-2.5">
				<PostboxTopicCard
					v-for="topic in shownNow"
					:key="topic.id"
					:topic="topic"
					:to="topicHref(topic)"
					:names="names"
					:page-keys="[]"
					:is-shared="isShared"
					:byline="bylineFor(topic)"
				/>
				<UiButton
					v-if="hiddenNow > 0"
					variant="secondary"
					size="sm"
					class="justify-self-start"
					@click="showAllNow = true"
				>
					{{ t('components.postbox.people.company.showMore', { count: hiddenNow }, hiddenNow) }}
				</UiButton>
			</div>
			<p v-else class="rounded-xl bg-bg-surface px-4 py-3 text-sm text-text-secondary">
				{{ t('components.postbox.people.company.nothingNow', { name: company.name }) }}
			</p>
			<div class="mt-10 flex items-baseline gap-2.5">
				<h2 class="text-xs font-semibold uppercase tracking-wider text-text-secondary">
					{{ t('components.postbox.people.company.earlierTitle') }}
				</h2>
				<span
					v-if="conversations.earlier.length > 0"
					class="text-xs tabular-nums text-text-tertiary"
					>{{ conversations.earlier.length }}</span
				>
			</div>
			<PostboxTopicList
				:topics="conversations.earlier"
				:href-for="topicHref"
				:mailbox-id="mailboxId"
				:tag-for="whoFor"
				:search-href="searchHref"
				:search-label="t('components.postbox.people.earlier.searchWith', { name: company.name })"
			/>
		</section>

		<section
			v-if="quietUpdates.length > 0"
			:class="company.isAutomated ? '' : 'mt-10'"
			:aria-labelledby="`updates-${company.key}`"
		>
			<div class="flex items-baseline gap-2.5">
				<!-- Section headings are labels, as in the column: the serif belongs to
				     the name of whoever the page is about. -->
				<h2
					:id="`updates-${company.key}`"
					class="text-xs font-semibold uppercase tracking-wider text-text-secondary"
				>
					{{ t('components.postbox.people.company.fromSystems', { name: company.name }) }}
				</h2>
				<span class="text-xs tabular-nums text-text-tertiary">{{ quietUpdates.length }}</span>
			</div>

			<PostboxTopicList
				:topics="quietUpdates"
				:href-for="topicHref"
				:mailbox-id="mailboxId"
				:older-for="machines.length === 1 ? machines[0]!.email : undefined"
				:shown-elsewhere="dueUpdates.map((x) => x.id)"
				:older-label="t('components.postbox.people.earlier.olderEmails')"
				with-snippet
				:tag-for="kindFor"
			/>
		</section>
	</article>
</template>
