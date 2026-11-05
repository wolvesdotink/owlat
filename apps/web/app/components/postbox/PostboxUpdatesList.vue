<script setup lang="ts">
/**
 * Updates: the mail machines send (newsletters, receipts, notifications), kept
 * out of the people list and read here as one quiet feed, grouped by day.
 * Each row names the sender, what kind of mail it is and its subject. Its menu
 * moves a sender that is really a person back to People; "Mark all read"
 * clears the feed's unread in one go.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { MoreHorizontalIcon, UserIcon } from '@coolicons/vue';
import {
	dayGroups,
	updateTopics,
	type DayBucket,
	type DirectoryIndex,
} from '~/utils/postboxConversations';
import { normalize, searchTerms, type PeopleTopic } from '~/utils/postboxPeople';
import {
	usePostboxListNow,
	usePostboxThreadTimestamp,
} from '~/composables/postbox/usePostboxListClock';

const props = defineProps<{
	index: DirectoryIndex;
	query: string;
	/** Narrowed to one company's updates. */
	from: string | null;
	activeTopicId: string | null;
	updatesHref: (from?: string | null) => string;
	hrefFor: (topic: PeopleTopic) => string;
}>();

const { t, locale } = useI18n();
const now = usePostboxListNow();
const stamp = usePostboxThreadTimestamp();

const company = computed(() => (props.from ? props.index.companies.get(props.from) : undefined));
const senderOf = (topic: PeopleTopic) =>
	props.index.accounts.get(topic.latestFromKey ?? topic.partyKeys[0] ?? '');
const topics = computed(() => {
	const terms = searchTerms(props.query);
	return updateTopics(props.index, props.from).filter((topic) => {
		if (terms.length === 0) return true;
		const sender = senderOf(topic);
		const haystack = normalize(
			[topic.title, topic.subject, sender?.name ?? '', sender?.email ?? ''].join(' ')
		);
		return terms.every((term) => haystack.includes(term));
	});
});
const groups = computed(() => dayGroups(topics.value, now.value));

function dayLabel(bucket: DayBucket, at: number): string {
	if (bucket === 'month') {
		return new Intl.DateTimeFormat(locale.value, { month: 'long', year: 'numeric' }).format(at);
	}
	return t(`components.postbox.conversations.updates.${bucket}`);
}
function kindLabel(topic: PeopleTopic): string | null {
	const kind = senderOf(topic)?.kind ?? topic.category;
	if (!kind || kind === 'person' || kind === 'other') return null;
	return t(`postbox.senders.kind.${kind}`);
}

const markReadOp = useBackendOperation(api.mail.messageActions.markThreadRead, {
	label: () => t('components.postbox.conversations.updates.markAllRead'),
});
const unread = computed(() => topics.value.filter((x) => x.unreadCount > 0));
async function markAllRead() {
	for (const topic of unread.value) {
		await markReadOp.run({ threadId: topic.id as Id<'mailThreads'>, seen: true });
	}
}

const moveOp = useBackendOperation(api.mail.category.recategorize, {
	label: () => t('components.postbox.conversations.updates.moveToPeople'),
});
const { showToast } = useToast();
async function moveToPeople(topic: PeopleTopic) {
	const result = await moveOp.run({ threadId: topic.id as Id<'mailThreads'>, label: 'person' });
	if (result.ok) {
		showToast(
			t('components.postbox.conversations.updates.movedToPeople', {
				name: senderOf(topic)?.name ?? topic.title,
			}),
			'success'
		);
	}
}
const menuFor = ref<string | null>(null);
</script>

<template>
	<div class="px-4">
		<div class="flex min-h-8 items-center gap-2 text-xs text-text-tertiary">
			<template v-if="company">
				<span class="truncate">{{
					t('components.postbox.conversations.updates.fromCompany', { name: company.name })
				}}</span>
				<NuxtLink
					:to="updatesHref()"
					class="flex-shrink-0 text-text-secondary hover:text-text-primary"
				>
					{{ t('components.postbox.conversations.updates.showAll') }}
				</NuxtLink>
			</template>
			<button
				v-if="unread.length > 0"
				type="button"
				class="ml-auto flex-shrink-0 rounded px-1.5 py-0.5 font-medium text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:opacity-60"
				:disabled="markReadOp.isLoading.value"
				@click="markAllRead"
			>
				{{ t('components.postbox.conversations.updates.markAllRead') }}
			</button>
		</div>

		<section v-for="group in groups" :key="group.key">
			<h3 class="mb-1 mt-4 text-xs font-semibold text-text-tertiary">
				{{ dayLabel(group.bucket, group.at) }}
			</h3>
			<div
				v-for="topic in group.items"
				:key="topic.id"
				class="group relative -mx-2 flex items-center gap-3 rounded-lg border-b border-border-subtle px-2 py-2.5"
				:class="activeTopicId === topic.id ? 'bg-bg-surface' : 'hover:bg-bg-surface-hover'"
			>
				<PostboxPeopleAvatar
					kind="company"
					:name="senderOf(topic)?.name ?? topic.title"
					:logo-url="senderOf(topic)?.logoUrl"
					is-automated
					:sender-kind="senderOf(topic)?.kind ?? null"
				/>
				<NuxtLink
					:to="hrefFor(topic)"
					data-pane-row
					:aria-current="activeTopicId === topic.id ? 'page' : undefined"
					class="min-w-0 flex-1 rounded outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-brand/40"
				>
					<span class="flex items-baseline gap-2">
						<span
							class="truncate text-sm text-text-primary"
							:class="topic.unreadCount > 0 ? 'font-bold' : 'font-semibold'"
							>{{ senderOf(topic)?.name ?? topic.title }}</span
						>
						<span
							v-if="kindLabel(topic)"
							class="flex-shrink-0 rounded bg-bg-soft px-1.5 text-[0.6875rem] font-semibold text-text-tertiary"
							>{{ kindLabel(topic) }}</span
						>
					</span>
					<span
						class="mt-0.5 line-clamp-2 text-[0.8125rem]"
						:class="
							activeTopicId === topic.id || topic.unreadCount > 0
								? 'text-text-primary'
								: 'text-text-secondary'
						"
						>{{ topic.title }}</span
					>
				</NuxtLink>
				<span
					class="flex-shrink-0 text-xs tabular-nums text-text-tertiary"
					:class="menuFor === topic.id ? 'hidden' : 'group-focus-within:hidden group-hover:hidden'"
					>{{ stamp(topic.lastMessageAt) }}</span
				>
				<div
					class="relative z-10 flex-shrink-0"
					:class="
						menuFor === topic.id ? 'block' : 'hidden group-focus-within:block group-hover:block'
					"
				>
					<UiDropdownMenu
						:open="menuFor === topic.id"
						@update:open="menuFor = $event ? topic.id : null"
					>
						<template #trigger>
							<button
								type="button"
								class="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
								:aria-label="t('components.postbox.conversations.updates.menu')"
							>
								<MoreHorizontalIcon class="h-4 w-4" />
							</button>
						</template>
						<UiDropdownMenuItem :icon="UserIcon" @click="moveToPeople(topic)">
							{{ t('components.postbox.conversations.updates.moveToPeople') }}
						</UiDropdownMenuItem>
					</UiDropdownMenu>
				</div>
			</div>
		</section>

		<p v-if="groups.length === 0" class="px-2 py-14 text-center text-sm text-text-tertiary">
			{{
				query.trim()
					? t('components.postbox.conversations.pane.noMatch')
					: t('components.postbox.conversations.updates.empty')
			}}
		</p>
	</div>
</template>
