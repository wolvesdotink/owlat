<script setup lang="ts">
/**
 * A person's or a company's page: who it is, then what you are talking about.
 * Open conversations (newest first; the first one that may need a reply is
 * raised as a card), narrowed by All · Reply? · Waiting, then the Done
 * ones. A company page can be narrowed to one of its people or departments,
 * and links to the company's Updates.
 */
import type { Id } from '@owlat/api/dataModel';
import { ChevronDownIcon, CloseIcon } from '@coolicons/vue';
import {
	departmentsOf,
	isCompanyRow,
	pageConversations,
	updateTopics,
	type DirectoryIndex,
	type Focus,
} from '~/utils/postboxConversations';
import { normalize, type PeopleSelection, type PeopleTopic } from '~/utils/postboxPeople';
import { walkTopicCards } from '~/composables/postbox/usePostboxPeople';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	index: DirectoryIndex;
	selection: PeopleSelection;
	focus: Focus;
	member: string | null;
	isShared: boolean;
	pageHref: (target: PeopleSelection, narrow?: { focus?: Focus; member?: string | null }) => string;
	updatesHref: (from?: string | null) => string;
	topicHref: (topic: PeopleTopic) => string;
	/** Conversations with a reply saved and unsent. */
	draftThreadIds: ReadonlySet<string>;
}>();
const emit = defineEmits<{ 'no-reply': [topic: PeopleTopic]; done: [topic: PeopleTopic] }>();

const { t } = useI18n();

const person = computed(() =>
	props.selection.kind === 'person' ? props.index.people.get(props.selection.key) : undefined
);
const company = computed(() => {
	if (props.selection.kind === 'company') return props.index.companies.get(props.selection.key);
	const key = person.value?.companyKey;
	return key ? props.index.companies.get(key) : undefined;
});
const name = computed(() => person.value?.name ?? company.value?.name ?? '');
const isCompanyPage = computed(() => props.selection.kind === 'company');
// A person's company is a link only when it has a page of its own.
const companyLink = computed(() =>
	!isCompanyPage.value && company.value && isCompanyRow(props.index, company.value)
		? props.pageHref({ kind: 'company', key: company.value.key })
		: null
);

const topicIds = computed(() => {
	if (person.value) return person.value.topicIds;
	const c = company.value;
	if (!c) return [];
	const ids = new Set<string>();
	for (const key of [...c.personKeys, ...departmentsOf(props.index, c).map((a) => a.key)]) {
		const owner = props.index.people.get(key) ?? props.index.accounts.get(key);
		for (const id of owner?.topicIds ?? []) ids.add(id);
	}
	return [...ids];
});
const conversations = computed(() =>
	pageConversations(props.index, topicIds.value, {
		focus: props.focus,
		memberKey: isCompanyPage.value ? props.member : null,
	})
);
const raisedId = computed(() => conversations.value.current.find((x) => x.turn === 'you')?.id);

// The company's people and departments, for "Everyone ▾".
const members = computed(() => {
	const c = company.value;
	if (!c || !isCompanyPage.value) return [];
	return [
		...c.personKeys.flatMap((key) => {
			const p = props.index.people.get(key);
			return p ? [{ key, name: p.name, kind: 'person' as const }] : [];
		}),
		...departmentsOf(props.index, c).map((a) => ({
			key: a.key,
			name: a.name,
			kind: 'company' as const,
		})),
	];
});
const memberName = computed(() => members.value.find((m) => m.key === props.member)?.name);
const memberQuery = ref('');
const memberMenuOpen = ref(false);
const filteredMembers = computed(() => {
	const q = normalize(memberQuery.value.trim());
	return q
		? members.value.filter((m) => normalize(`${m.name} ${m.key}`).includes(q))
		: members.value;
});

const updates = computed(() =>
	isCompanyPage.value && company.value ? updateTopics(props.index, company.value.key) : []
);

const focusOptions = computed(() =>
	(['all', 'reply', 'waiting'] as const).map((id) => ({
		id,
		label: t(`components.postbox.conversations.page.focus.${id}`),
		count: conversations.value.counts[id],
		href: props.pageHref(props.selection, { focus: id, member: props.member }),
	}))
);

const headingEl = ref<HTMLElement | null>(null);
defineExpose({ focusHeading: () => headingEl.value?.focus() });
</script>

<template>
	<div class="mx-auto w-full max-w-[48.75rem] px-6 pb-16 pt-10 sm:px-9" @keydown="walkTopicCards">
		<header class="flex items-center gap-4">
			<PostboxPeopleAvatar
				:kind="isCompanyPage ? 'company' : 'person'"
				size="xl"
				:name="name"
				:color-key="person?.key"
				:logo-url="isCompanyPage ? company?.logoUrl : undefined"
			/>
			<div class="min-w-0">
				<h1
					ref="headingEl"
					tabindex="-1"
					class="truncate text-[1.875rem] font-semibold leading-tight tracking-[-0.02em] text-text-primary outline-none"
				>
					{{ name }}
				</h1>
				<p class="mt-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-text-tertiary">
					<template v-if="person">
						<NuxtLink
							v-if="companyLink"
							:to="companyLink"
							class="font-medium text-text-secondary hover:text-text-primary"
							>{{ company?.name }}</NuxtLink
						>
						<span v-else-if="company">{{ company.name }}</span>
						<span v-if="company" aria-hidden="true">·</span>
						<span class="truncate">{{ person.email }}</span>
					</template>
					<template v-else-if="company">
						<span>{{ t('components.postbox.conversations.page.company') }}</span>
						<template v-if="company.domain">
							<span aria-hidden="true">·</span>
							<span>{{ company.domain }}</span>
						</template>
						<template v-if="members.length > 1">
							<span aria-hidden="true">·</span>
							<UiDropdownMenu v-model:open="memberMenuOpen" position="left">
								<template #trigger>
									<button
										type="button"
										class="inline-flex items-center gap-1 font-medium text-text-secondary hover:text-text-primary"
									>
										{{ memberName ?? t('components.postbox.conversations.page.everyone') }}
										<ChevronDownIcon class="h-3 w-3" />
									</button>
								</template>
								<div class="px-2 pb-1 pt-1.5">
									<input
										v-model="memberQuery"
										type="search"
										class="input input-sm"
										:placeholder="t('components.postbox.conversations.page.findPerson')"
										:aria-label="t('components.postbox.conversations.page.findPerson')"
									/>
								</div>
								<UiDropdownMenuItem
									v-if="member"
									:icon="CloseIcon"
									@click="navigateTo(pageHref(selection, { focus }))"
								>
									{{ t('components.postbox.conversations.page.everyone') }}
								</UiDropdownMenuItem>
								<UiDropdownMenuItem
									v-for="m in filteredMembers"
									:key="m.key"
									@click="navigateTo(pageHref(selection, { focus, member: m.key }))"
								>
									<span class="flex items-center gap-2">
										<PostboxPeopleAvatar
											:kind="m.kind"
											size="sm"
											:name="m.name"
											:color-key="m.kind === 'person' ? m.key : undefined"
										/>
										<span :class="m.key === member ? 'font-semibold' : ''">{{ m.name }}</span>
									</span>
								</UiDropdownMenuItem>
							</UiDropdownMenu>
						</template>
					</template>
				</p>
			</div>
		</header>

		<nav
			class="mb-2 mt-7 flex gap-1"
			:aria-label="t('components.postbox.conversations.page.focus.label')"
		>
			<NuxtLink
				v-for="option in focusOptions"
				:key="option.id"
				:to="option.href"
				replace
				class="rounded-full px-3 py-1 text-[0.8125rem]"
				:class="
					focus === option.id
						? 'bg-text-primary font-semibold text-bg-base'
						: 'font-medium text-text-secondary hover:bg-bg-surface hover:text-text-primary'
				"
				:aria-current="focus === option.id ? 'page' : undefined"
			>
				{{ option.label
				}}<span class="ml-1" :class="focus === option.id ? 'opacity-60' : 'text-text-tertiary'">{{
					option.count
				}}</span>
			</NuxtLink>
		</nav>

		<h2
			class="mb-1.5 mt-6 text-[0.6875rem] font-bold uppercase tracking-[0.09em] text-text-tertiary"
		>
			{{ t('components.postbox.conversations.page.open') }}
		</h2>
		<div v-if="conversations.current.length > 0" class="flex flex-col gap-0.5">
			<PostboxTopicRow
				v-for="topic in conversations.current"
				:key="topic.id"
				:topic="topic"
				:index="index"
				:href="topicHref(topic)"
				:is-shared="isShared"
				:show-party="isCompanyPage"
				:is-raised="topic.id === raisedId"
				:has-draft="draftThreadIds.has(topic.id)"
				@no-reply="emit('no-reply', $event)"
				@done="emit('done', $event)"
			/>
		</div>
		<p v-else class="py-2 text-sm text-text-tertiary">
			{{
				focus === 'reply'
					? t('components.postbox.conversations.page.noneReply')
					: focus === 'waiting'
						? t('components.postbox.conversations.page.noneWaiting')
						: t('components.postbox.conversations.page.noneOpen', { name })
			}}
		</p>

		<PostboxEarlierList
			v-if="focus === 'all'"
			:key="selection.key"
			:mailbox-id="mailboxId"
			:topics="conversations.earlier"
			:shown-above="conversations.current.map((x) => x.id)"
			:older-for="person?.email ?? null"
			:href-for="topicHref"
		/>

		<p v-if="updates.length > 0 && !member" class="mt-8 text-[0.8125rem] text-text-tertiary">
			<NuxtLink
				:to="updatesHref(company?.key ?? null)"
				class="font-medium text-text-secondary hover:text-text-primary"
				>{{ t('components.postbox.conversations.page.updatesFrom', { name }) }}</NuxtLink
			>
			<span aria-hidden="true"> · </span>
			<span>{{ updates[0]?.title }}</span>
		</p>
	</div>
</template>
