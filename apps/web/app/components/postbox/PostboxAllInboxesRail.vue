<script setup lang="ts">
/**
 * Pane 1 of All inboxes, where a single inbox has its folder rail: the merged
 * list, then one row per inbox that narrows the list to it (`?in=`) and a
 * link that opens that inbox on its own, with its folders. The team inbox
 * (owners and admins) is a separate product with its own list, so it is a
 * link out rather than a filter.
 */
import { allInboxesHref } from '~/utils/postboxAllInboxes';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import InboxChip from '~/components/inbox/InboxChip.vue';
import { ArrowUpRightIcon, InboxIcon, RobotIcon } from '@coolicons/vue';

defineProps<{
	inboxes: readonly InboxIdentity[];
	/** The inbox the list is narrowed to, or null for every inbox. */
	only: string | null;
	/** The category filter, kept when switching inboxes. */
	category: string | null;
}>();

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const showTeamInbox = computed(() => isAdmin.value && isEnabled('inbox'));

const ROW_CLASS = 'flex items-center gap-2 px-2.5 py-1 rounded text-sm min-w-0';
</script>

<template>
	<aside class="w-56 p-3 flex flex-col gap-2 border-r border-border-subtle bg-bg-elevated">
		<NuxtLink
			:to="allInboxesHref({ category })"
			:class="[ROW_CLASS, only ? 'hover:bg-bg-surface' : 'bg-bg-surface text-brand']"
			:aria-current="only ? undefined : 'page'"
			data-testid="all-inboxes-rail-all"
		>
			<InboxIcon class="w-4 h-4 flex-shrink-0" />
			<span class="truncate">{{ t('components.postbox.allInboxes.title') }}</span>
		</NuxtLink>

		<div class="mt-3">
			<header class="mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.allInboxes.inboxesHeading')
				}}</span>
			</header>
			<ul class="flex flex-col gap-0.5">
				<li v-for="inbox in inboxes" :key="inbox.mailboxId" class="group flex items-center">
					<NuxtLink
						:to="allInboxesHref({ in: inbox.mailboxId, category })"
						:class="[
							ROW_CLASS,
							'flex-1',
							only === inbox.mailboxId ? 'bg-bg-surface text-brand' : 'hover:bg-bg-surface',
						]"
						:aria-current="only === inbox.mailboxId ? 'page' : undefined"
						data-testid="all-inboxes-rail-inbox"
					>
						<InboxChip
							:name="inbox.name"
							:slot="inbox.slot"
							:mark="inbox.mark"
							variant="plain"
							size="md"
						/>
						<span v-if="inbox.unread > 0" class="ml-auto text-xs tabular-nums text-text-tertiary">{{
							inbox.unread
						}}</span>
					</NuxtLink>
					<UiTooltip :text="t('components.postbox.allInboxes.openInbox', { name: inbox.name })">
						<NuxtLink
							:to="`/dashboard/postbox/inbox?mailbox=${inbox.mailboxId}`"
							class="p-1 rounded text-text-tertiary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary"
							:aria-label="t('components.postbox.allInboxes.openInbox', { name: inbox.name })"
						>
							<ArrowUpRightIcon class="w-3.5 h-3.5" />
						</NuxtLink>
					</UiTooltip>
				</li>
			</ul>
		</div>

		<PostboxRailLink
			v-if="showTeamInbox"
			class="mt-3"
			to="/dashboard/inbox"
			:icon="RobotIcon"
			:label="t('components.shell.teamInbox')"
		/>
	</aside>
</template>
