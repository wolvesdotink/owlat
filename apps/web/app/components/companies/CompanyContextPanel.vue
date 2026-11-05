<script setup lang="ts">
/**
 * The company context beside an open conversation: for each company in it
 * (usually one), the people there, which colleagues are in touch with it, and
 * the viewer's earlier conversations with it; then this conversation's tasks
 * and "Make task".
 *
 * The server answers only for a conversation the viewer can open, and a
 * colleague's personal mail reaches this panel as the colleague's name alone
 * (`companies/read.ts`). A conversation without a company shows only the
 * tasks, since it can still produce one.
 *
 * Reads its own data, so a host only places it. `useConversationContext`
 * reads the same queries (one shared subscription) when a host needs to know
 * what the panel will show.
 */
import type { Id } from '@owlat/api/dataModel';
import { useCompanyColleagues } from '~/composables/companies/useCompanyColleagues';
import { useConversationContext } from '~/composables/companies/useConversationContext';
import {
	companyConversationHref,
	companyHref,
	conversationPeople,
	personLabel,
} from '~/utils/companies';
import { formatCompactRelativeTime } from '~/utils/formatters';
import BriefSection from '~/components/brief/BriefSection.vue';
import CompanyLogo from './CompanyLogo.vue';
import CompanyTaskList from './CompanyTaskList.vue';
import { UsersIcon } from '@coolicons/vue';

const props = defineProps<{
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
}>();

const { t } = useI18n();
const context = useConversationContext(() => props);
const { companies, tasks, hasError } = context;
const { lineFor } = useCompanyColleagues();

/** A task made here is about the conversation's first company. */
const taskCompanyKey = computed(() => companies.value[0]?.key);
const headingId = useId();

type Company = (typeof companies.value)[number];
type Conversation = Company['conversations'][number];

function peopleOf(company: Company, conversation: Conversation): string {
	const { shown, more } = conversationPeople(conversation.addresses, company.people);
	const names = shown.join(', ');
	return more > 0 ? t('components.companies.context.peopleMore', { names, count: more }) : names;
}

function sourceOf(conversation: Conversation): string {
	if (conversation.kind === 'team') return t('components.companies.teamInbox');
	return conversation.mailboxName ?? t('components.companies.mailbox');
}
</script>

<template>
	<div class="space-y-5" data-testid="company-context">
		<section
			v-for="company in companies"
			:key="company.key"
			class="space-y-3"
			:aria-labelledby="`${headingId}-${company.key}`"
			data-testid="company-context-company"
		>
			<NuxtLink
				:to="companyHref(company.key)"
				class="group -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-bg-surface outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
			>
				<CompanyLogo :company-key="company.key" :name="company.name" />
				<span class="min-w-0">
					<h3
						:id="`${headingId}-${company.key}`"
						class="truncate text-sm font-medium text-text-primary group-hover:underline"
					>
						{{ company.name }}
					</h3>
					<span class="block truncate text-xs text-text-tertiary">{{ company.key }}</span>
				</span>
			</NuxtLink>

			<ul
				v-if="company.people.length > 0"
				class="space-y-1"
				:aria-label="t('components.companies.context.people', { company: company.name })"
			>
				<li
					v-for="person in company.people"
					:key="person.address"
					class="flex min-w-0 items-center gap-2 text-sm"
					:title="person.address"
				>
					<UiAvatar
						:name="person.name"
						:email="person.address"
						size="xs"
						deterministic-color
						aria-hidden="true"
					/>
					<span class="truncate text-text-secondary">{{ personLabel(person) }}</span>
				</li>
			</ul>

			<p
				v-if="lineFor(company)"
				class="flex items-start gap-2 rounded-lg bg-bg-soft px-2.5 py-2 text-xs text-text-secondary"
				data-testid="company-colleagues"
			>
				<UsersIcon class="mt-px h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
				<span>{{ lineFor(company) }}</span>
			</p>

			<BriefSection
				v-if="company.conversations.length > 0"
				:title="t('components.companies.context.earlier', { company: company.name })"
				:heading-id="`${headingId}-${company.key}-earlier`"
			>
				<ul class="space-y-1">
					<li
						v-for="conversation in company.conversations"
						:key="
							conversation.mailThreadId ?? conversation.conversationThreadId ?? conversation.subject
						"
					>
						<NuxtLink
							v-if="companyConversationHref(conversation)"
							:to="companyConversationHref(conversation)!"
							class="-mx-1.5 block rounded-md px-1.5 py-1 hover:bg-bg-surface outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
							data-testid="company-context-conversation"
						>
							<span class="block truncate text-sm text-text-primary">
								{{ conversation.subject || t('components.companies.noSubject') }}
							</span>
							<span class="block truncate text-xs text-text-tertiary">
								{{ peopleOf(company, conversation) }} · {{ sourceOf(conversation) }} ·
								<time :datetime="new Date(conversation.lastMessageAt).toISOString()">{{
									formatCompactRelativeTime(conversation.lastMessageAt)
								}}</time>
							</span>
						</NuxtLink>
						<div v-else class="-mx-1.5 px-1.5 py-1" data-testid="company-context-conversation">
							<span class="block truncate text-sm text-text-primary">
								{{ conversation.subject || t('components.companies.noSubject') }}
							</span>
							<span class="block truncate text-xs text-text-tertiary">
								{{ peopleOf(company, conversation) }} · {{ sourceOf(conversation) }} ·
								<time :datetime="new Date(conversation.lastMessageAt).toISOString()">{{
									formatCompactRelativeTime(conversation.lastMessageAt)
								}}</time>
							</span>
						</div>
					</li>
				</ul>
			</BriefSection>
		</section>

		<BriefSection
			:class="{ 'border-t border-border-subtle pt-4': companies.length > 0 }"
			:title="t('components.companies.context.tasks')"
			:heading-id="`${headingId}-tasks`"
		>
			<template #note>
				<TasksTaskCreatePopover
					:mail-thread-id="mailThreadId"
					:conversation-thread-id="conversationThreadId"
					:company-key="taskCompanyKey"
					default-title=""
					size="sm"
					variant="ghost"
				/>
			</template>
			<CompanyTaskList v-if="tasks.length > 0" :tasks="tasks" compact />
			<p v-else class="text-xs text-text-tertiary" data-testid="company-context-no-tasks">
				{{ t('components.companies.context.noTasks') }}
			</p>
		</BriefSection>

		<p v-if="hasError" class="text-xs text-text-tertiary" data-testid="company-context-error">
			{{ t('components.companies.context.loadFailed') }}
			<button type="button" class="text-brand hover:underline" @click="context.refetch()">
				{{ t('common.retry') }}
			</button>
		</p>
	</div>
</template>
