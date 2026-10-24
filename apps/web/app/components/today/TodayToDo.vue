<script setup lang="ts">
/**
 * The Workbench band "To do, no reply needed": mail that needs no answer but still owes something, such as an
 * invoice to pay or a domain to renew. One row per thread, its first open
 * item in due order, read from the thread brief (mail/interpret/todo.ts). A
 * row opens the thread on its Overview.
 *
 * Personal and shared mailboxes alike; renders nothing when there is nothing
 * to do, and nothing for the team inbox tab (no mailbox there). When more
 * threads owe something than the band lists, it says so.
 *
 * With the viewer's brief turned off ("Show the brief above conversations"),
 * a personal mailbox's row is its subject and sender, without the item's AI
 * wording or the "+N more" chip; a shared mailbox's rows are the team's
 * actions and stay.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { briefDueDate } from '~/utils/threadBriefContext';
import { briefMoreChip } from '~/utils/briefRowLine';

const props = defineProps<{ mailboxId: string }>();

const { t, locale } = useI18n();
const { autoSummarize } = usePostboxSettings();
const { byId } = useInboxes();
const isPlain = computed(
	() => !autoSummarize.value && byId.value.get(props.mailboxId as never)?.scope !== 'shared'
);

const { data } = useConvexQuery(api.mail.interpret.todo.listNoReplyToDo, () => ({
	mailboxId: props.mailboxId as Id<'mailboxes'>,
}));
const rows = computed(() => data.value?.rows ?? []);
/** More threads owe something than the band lists: said, never dropped silently. */
const isTruncated = computed(() => data.value?.isTruncated === true);

type Row = (typeof rows.value)[number];

function title(row: Row): string {
	if (isPlain.value) return row.subject || t('components.shell.noSubject');
	return locale.value.toLowerCase().startsWith('de') ? row.text.de : row.text.en;
}
function detail(row: Row): string {
	const from = row.fromName || row.fromAddress;
	return (isPlain.value ? [from] : [from, row.subject]).filter(Boolean).join(' · ');
}
function more(row: Row): string {
	if (isPlain.value) return '';
	const chip = briefMoreChip(row.count);
	return chip ? t(chip.key, { count: chip.count }) : '';
}
function href(row: Row): string {
	const target = row.messageId ?? '';
	return `/dashboard/postbox/inbox/${target}?mailbox=${props.mailboxId}&view=overview`;
}
</script>

<template>
	<section
		v-if="rows.length > 0 || isTruncated"
		aria-labelledby="today-todo"
		data-testid="today-todo"
	>
		<h3
			id="today-todo"
			class="mb-2 mt-8 flex items-center text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{
				rows.length > 0
					? t('components.today.todo.title', { count: rows.length })
					: t('components.today.todo.titlePlain')
			}}
		</h3>
		<ul
			v-if="rows.length > 0"
			class="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated"
		>
			<li v-for="row in rows" :key="row.threadId">
				<NuxtLink
					:to="href(row)"
					class="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-bg-surface"
					data-today-line
				>
					<span class="min-w-0 flex-1">
						<span class="flex min-w-0 items-center gap-1.5">
							<span class="truncate text-sm font-medium text-text-primary">{{ title(row) }}</span>
							<span
								v-if="more(row)"
								class="shrink-0 rounded-full bg-bg-surface px-1.5 text-2xs font-medium text-text-secondary"
								>{{ more(row) }}</span
							>
						</span>
						<span class="block truncate text-xs text-text-tertiary">{{ detail(row) }}</span>
					</span>
					<span v-if="row.dueAt !== undefined" class="shrink-0 text-2xs text-text-secondary">{{
						t('components.today.todo.due', { date: briefDueDate(row.dueAt, locale) })
					}}</span>
				</NuxtLink>
			</li>
		</ul>
		<p v-if="isTruncated" class="mt-2 text-xs text-text-tertiary" data-testid="today-todo-more">
			{{ t('components.today.todo.more') }}
			<NuxtLink
				:to="`/dashboard/postbox/inbox?mailbox=${mailboxId}`"
				class="text-brand hover:underline"
				>{{ t('components.today.todo.openInbox') }}</NuxtLink
			>
		</p>
	</section>
</template>
