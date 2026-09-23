<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { TodayChange } from '~/utils/todayDigest';

/**
 * "What changed": conversations the viewer already knew (they opened or
 * answered them) that moved since they last looked. Each row says what is
 * new, and the new messages are linked, quietly, as its sources.
 */
const props = defineProps<{ changes: readonly TodayChange[]; hidden: number }>();
const emit = defineEmits<{ done: [change: TodayChange] }>();
const { t } = useI18n();
const { byId } = useInboxes();

function inboxOf(change: TodayChange) {
	return byId.value.get(change.inboxId as Id<'mailboxes'>) ?? null;
}
function latestName(change: TodayChange): string {
	const s = change.latest;
	return s ? s.fromName || s.fromAddress : '';
}
</script>

<template>
	<section v-if="props.changes.length > 0" aria-labelledby="today-changed">
		<h3
			id="today-changed"
			class="mb-2 mt-8 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{ t('components.today.changed.title') }}
			<span class="normal-case tracking-normal">{{ t('components.today.changed.subtitle') }}</span>
		</h3>
		<ul class="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-bg-elevated">
			<li
				v-for="change in props.changes"
				:key="change.key"
				class="group relative flex items-start gap-3 px-4 py-3 focus-within:bg-bg-surface"
				tabindex="-1"
				data-today-line
				:data-today-key="change.key"
			>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium text-text-primary">
						{{ change.subject || t('components.shell.noSubject') }}
					</p>
					<p class="mt-0.5 text-xs leading-relaxed text-text-secondary">
						<template v-if="change.summary">
							<TodaySourceLink :text="change.summary" :sources="change.sources" />
						</template>
						<template v-else-if="change.latest">
							{{
								t(
									'components.today.changed.newFrom',
									{ count: change.newMessages, name: latestName(change) },
									change.newMessages
								)
							}}
							<TodaySourceLink
								:text="change.latest.snippet || change.latest.subject"
								:sources="change.sources"
							/>
						</template>
					</p>
				</div>
				<div class="flex shrink-0 flex-col items-end gap-1">
					<InboxChip
						v-if="inboxOf(change)"
						:name="inboxOf(change)!.name"
						:slot="inboxOf(change)!.slot"
					/>
					<span class="text-2xs text-text-tertiary">{{
						formatCompactRelativeTime(change.at)
					}}</span>
				</div>
				<button
					type="button"
					class="absolute right-24 top-3 rounded-md border border-border-subtle bg-bg-elevated px-2 py-0.5 text-2xs text-text-secondary opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100 max-md:static max-md:opacity-100"
					@click="emit('done', change)"
				>
					{{ t('components.today.line.done') }}
				</button>
			</li>
		</ul>
		<p v-if="props.hidden > 0" class="mt-2 text-xs text-text-tertiary">
			{{ t('components.today.changed.more', { count: props.hidden }, props.hidden) }}
			<NuxtLink to="/dashboard/inboxes" class="text-brand hover:underline">{{
				t('components.today.openInboxes')
			}}</NuxtLink>
		</p>
	</section>
</template>
