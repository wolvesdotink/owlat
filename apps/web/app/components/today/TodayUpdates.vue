<script setup lang="ts">
import type { ImportantReason, TodayLine, TodayModel } from '~/utils/todayDigest';

/**
 * "Updates": everything in this inbox that needs no reply, as a short digest.
 * What people told the viewer and alerts that want action come first
 * ("Important"), routine mail after ("Also arrived"). Newsletters and the
 * like never show up here; `TodayFiledAway` counts them below.
 *
 * Keyboard (as on the old Updates page): j/k move between lines, Enter opens
 * the first source, d marks a line done, r asks for a reply after all
 * (team-inbox lines, which then go to the Answer queue).
 */
const props = withDefaults(defineProps<{ model: TodayModel; moreHref?: string }>(), {
	moreHref: '/dashboard/inboxes',
});
const emit = defineEmits<{ done: [line: TodayLine]; replyAnyway: [line: TodayLine] }>();
const { t } = useI18n();

/** A small label says why a line is important when "a person wrote" is not the reason. */
const REASON_LABEL: Partial<Record<ImportantReason, { key: string; icon: string; tone: string }>> =
	{
		alert: {
			key: 'components.today.reason.alert',
			icon: 'lucide:triangle-alert',
			tone: 'bg-warning-subtle text-warning',
		},
		new_sender: {
			key: 'components.today.reason.newSender',
			icon: 'lucide:user-plus',
			tone: 'bg-bg-surface text-text-secondary',
		},
	};

const isEmpty = computed(() => props.model.worth.length === 0 && props.model.also.length === 0);
</script>

<template>
	<section id="workbench-updates" aria-labelledby="today-updates">
		<h3
			id="today-updates"
			class="mb-2 mt-8 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{ t('components.today.updates.title') }}
			<span class="normal-case tracking-normal">{{ t('components.today.updates.subtitle') }}</span>
			<span class="ml-auto hidden normal-case tracking-normal md:inline">
				<kbd class="font-mono">j</kbd> <kbd class="font-mono">k</kbd>
				{{ t('components.today.updates.keysMove') }} · <kbd class="font-mono">d</kbd>
				{{ t('components.today.line.done') }} · <kbd class="font-mono">r</kbd>
				{{ t('components.today.line.replyAnyway') }}
			</span>
		</h3>

		<div
			v-if="isEmpty"
			class="rounded-xl border border-dashed border-border-subtle px-4 py-5 text-sm text-text-secondary"
		>
			{{ t('components.today.updates.empty') }}
		</div>

		<div v-else class="rounded-xl border border-border-subtle bg-bg-elevated pb-2">
			<template
				v-for="group in [
					{ id: 'worth', title: t('components.today.updates.worth'), lines: model.worth },
					{ id: 'also', title: t('components.today.updates.also'), lines: model.also },
				]"
				:key="group.id"
			>
				<template v-if="group.lines.length > 0">
					<p
						class="px-4 pb-1 pt-3 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
					>
						{{ group.title }}
					</p>
					<div
						v-for="line in group.lines"
						:key="line.key"
						class="group relative flex items-baseline gap-3 px-4 py-1.5 outline-none focus:bg-bg-surface"
						:class="
							group.id === 'also' ? 'text-xs text-text-secondary' : 'text-sm text-text-primary'
						"
						tabindex="-1"
						data-today-line
						:data-today-key="line.key"
					>
						<p class="min-w-0 flex-1 leading-relaxed">
							<span
								v-if="line.reason && REASON_LABEL[line.reason]"
								class="mr-1.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-full px-1.5 py-px align-middle text-2xs font-medium"
								:class="REASON_LABEL[line.reason]!.tone"
								><Icon :name="REASON_LABEL[line.reason]!.icon" class="size-3" />{{
									t(REASON_LABEL[line.reason]!.key)
								}}</span
							>
							<!-- A summary already says who it is from; a bare subject needs the sender. -->
							<template v-if="!line.isSummary">
								<span
									class="font-medium"
									:class="group.id === 'also' ? 'text-text-secondary' : 'text-text-primary'"
									>{{ line.lead }}</span
								>
								<span class="text-text-tertiary"> · </span>
							</template>
							<TodaySourceLink :text="line.text" :sources="line.sources" />
						</p>
						<span class="flex shrink-0 items-center gap-2">
							<span
								class="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus:opacity-100 max-md:hidden"
							>
								<button
									v-if="line.inboundMessageId"
									type="button"
									class="rounded border border-border-subtle bg-bg-elevated px-1.5 py-px text-2xs text-text-secondary hover:text-text-primary"
									@click="emit('replyAnyway', line)"
								>
									{{ t('components.today.line.replyAnyway') }}
								</button>
								<button
									type="button"
									class="rounded border border-border-subtle bg-bg-elevated px-1.5 py-px text-2xs text-text-secondary hover:text-text-primary"
									@click="emit('done', line)"
								>
									{{ t('components.today.line.done') }}
								</button>
							</span>
							<span class="text-2xs tabular-nums text-text-tertiary">{{
								formatCompactRelativeTime(line.at)
							}}</span>
						</span>
					</div>
				</template>
			</template>
			<p v-if="model.alsoHidden > 0" class="px-4 pt-1 text-xs text-text-tertiary">
				{{ t('components.today.updates.more', { count: model.alsoHidden }, model.alsoHidden) }}
				<NuxtLink :to="props.moreHref" class="text-brand hover:underline">{{
					t('components.today.openInbox')
				}}</NuxtLink>
			</p>
		</div>
	</section>
</template>
