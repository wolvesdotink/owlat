<script setup lang="ts">
/**
 * The company context folded to one line, for a reader pane too narrow for the
 * rail beside it: "Northwind · 3 open tasks · Taylor also in touch". The line
 * is a button that opens the whole panel in place, right under what the
 * conversation is for, instead of leaving it below the last message.
 *
 * Says nothing until there is something to show: a conversation with no
 * company and no tasks has nothing here (its Make task is in the purpose
 * header).
 */
import type { Id } from '@owlat/api/dataModel';
import { useCompanyColleagues } from '~/composables/companies/useCompanyColleagues';
import { useConversationContext } from '~/composables/companies/useConversationContext';
import CompanyContextPanel from './CompanyContextPanel.vue';
import { ChevronRightIcon } from '@coolicons/vue';

const props = defineProps<{
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
}>();

const { t } = useI18n();
const context = useConversationContext(() => props);
const { companies, openCount } = context;
const { lineFor } = useCompanyColleagues();
const open = ref(false);
const panelId = useId();

const isShown = computed(() => companies.value.length > 0 || context.openWork.value.length > 0);

const summary = computed(() => {
	const first = companies.value[0];
	const parts: string[] = [];
	if (first) {
		const others = companies.value.length - 1;
		parts.push(others > 0 ? `${first.name} +${others}` : first.name);
	} else {
		parts.push(t('components.companies.context.tasks'));
	}
	if (openCount.value > 0) {
		parts.push(
			t('components.companies.disclosure.openTasks', { count: openCount.value }, openCount.value)
		);
	}
	const colleagues = first ? lineFor(first, { short: true }) : null;
	if (colleagues) parts.push(colleagues);
	return parts.join(' · ');
});
</script>

<template>
	<div v-if="isShown" data-testid="company-disclosure">
		<button
			type="button"
			class="-mx-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm text-text-secondary outline-none hover:bg-bg-surface hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40"
			:aria-expanded="open"
			:aria-controls="panelId"
			data-testid="company-disclosure-toggle"
			@click="open = !open"
		>
			<span class="min-w-0 truncate">{{ summary }}</span>
			<ChevronRightIcon
				class="size-4 shrink-0 text-text-tertiary transition-transform duration-(--motion-fast)"
				:class="{ 'rotate-90': open }"
				aria-hidden="true"
			/>
		</button>
		<div
			v-show="open"
			:id="panelId"
			class="mt-2 rounded-xl border border-border-subtle bg-bg-elevated p-4"
			data-testid="company-disclosure-panel"
		>
			<CompanyContextPanel
				v-if="open"
				:mail-thread-id="mailThreadId"
				:conversation-thread-id="conversationThreadId"
			/>
		</div>
	</div>
</template>
