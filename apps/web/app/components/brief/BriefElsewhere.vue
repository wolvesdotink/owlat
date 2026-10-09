<script setup lang="ts">
/**
 * "With Jonas elsewhere" (plan §4.3, ADR-0072): the open items this thread's
 * people have with you in other conversations, e.g. the signed NDA Jonas
 * still owes you in "Framework agreement". Each row links to its thread.
 *
 * Reads `mail.interpret.elsewhere.list` itself, so a host only places it:
 * the personal Overview and the Team Inbox side column. The server filters
 * every item by its own thread's access; nothing renders when there is
 * nothing to show.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { briefLocale } from '~/composables/threadBrief/briefApi';
import { briefShortDate } from '~/utils/threadBriefContext';
import BriefSection from './BriefSection.vue';

type ThreadRefArg =
	| { kind: 'mail'; id: Id<'mailThreads'> }
	| { kind: 'team'; id: Id<'conversationThreads'> };
type Groups = NonNullable<FunctionReturnType<typeof api.mail.interpret.elsewhere.list>>['groups'];
type Item = Groups[number]['items'][number];

const props = defineProps<{ threadRef: ThreadRefArg | null }>();

const { t, locale } = useI18n();

const { data } = useConvexQuery(api.mail.interpret.elsewhere.list, () =>
	props.threadRef ? { threadRef: props.threadRef, locale: briefLocale(locale.value) } : 'skip'
);
const groups = computed<Groups>(() => data.value?.groups ?? []);

function hrefOf(item: Item): string {
	if (item.threadRef.kind === 'team') return `/dashboard/inbox/${item.threadRef.id}`;
	if (!item.messageId) return '/dashboard/postbox';
	return `/dashboard/postbox/inbox/${item.messageId}${item.mailboxId ? `?mailbox=${item.mailboxId}` : ''}`;
}

function sideOf(item: Item): string {
	if (item.responsibility === 'us') return t('components.brief.elsewhere.forYou');
	if (item.responsibility === 'them') return t('components.brief.elsewhere.theirs');
	return t('components.brief.elsewhere.unclear');
}
</script>

<template>
	<div v-if="groups.length > 0" data-testid="brief-elsewhere">
		<BriefSection
			v-for="group in groups"
			:key="group.counterpartyKey"
			:title="t('components.brief.elsewhere.title', { name: group.name ?? group.counterpartyKey })"
			:heading-id="`brief-elsewhere-${group.counterpartyKey}`"
		>
			<ul class="space-y-1.5">
				<li v-for="item in group.items" :key="item.itemId" class="text-sm">
					<NuxtLink
						:to="hrefOf(item)"
						class="group block rounded-md -mx-1 px-1 hover:bg-bg-surface"
					>
						<span class="text-text-primary">{{ item.text }}</span>
						<span class="block text-xs text-text-tertiary">
							{{ t('components.brief.elsewhere.inThread', { subject: item.subject }) }}
							· {{ sideOf(item) }}
							<template v-if="item.dueAt !== undefined">
								·
								{{
									t('components.brief.elsewhere.due', {
										date: briefShortDate(item.dueAt, locale),
									})
								}}
							</template>
						</span>
					</NuxtLink>
				</li>
			</ul>
			<p v-if="group.isMore || group.continueCursor" class="mt-1.5 text-xs text-text-tertiary">
				{{ t('components.brief.elsewhere.more') }}
			</p>
		</BriefSection>
	</div>
</template>
