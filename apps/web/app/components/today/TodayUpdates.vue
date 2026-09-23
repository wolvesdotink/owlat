<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { FiledKey, TodayLine, TodayModel } from '~/utils/todayDigest';

/**
 * "Updates": everything that needs no reply, as a short digest instead of a
 * separate page. What people told the viewer comes first ("Worth knowing"),
 * routine mail after ("Also arrived"), and the last line counts what was
 * filed away — each count opens that exact list, so nothing hides silently.
 *
 * Keyboard (as on the old Updates page): j/k move between lines, Enter opens
 * the first source, d marks a line done, r asks for a reply after all
 * (team-inbox lines, which then go to the Answer queue).
 */
const props = defineProps<{ model: TodayModel; teamOn: boolean }>();
const emit = defineEmits<{ done: [line: TodayLine]; replyAnyway: [line: TodayLine] }>();
const { t } = useI18n();
const { byId } = useInboxes();

function inboxOf(line: TodayLine) {
	return line.inboxId === 'team' ? null : (byId.value.get(line.inboxId as Id<'mailboxes'>) ?? null);
}

const FILED_ORDER: readonly FiledKey[] = [
	'newsletter',
	'notification',
	'receipt',
	'promotion',
	'spam',
];
function filedHref(key: FiledKey): string {
	// Team-only counts (promotions / spam live in the team inbox's views) open
	// its list; the rest open the matching category across all inboxes.
	if (props.teamOn && (key === 'promotion' || key === 'spam')) {
		return `/dashboard/inbox/updates?view=${key === 'promotion' ? 'promotions' : 'spam'}`;
	}
	return `/dashboard/inboxes?category=${key}`;
}
const filedParts = computed(() =>
	FILED_ORDER.filter((key) => props.model.filed[key] > 0).map((key) => ({
		key,
		label: t(
			`components.today.filed.${key}`,
			{ count: props.model.filed[key] },
			props.model.filed[key]
		),
		href: filedHref(key),
	}))
);

const isEmpty = computed(
	() =>
		props.model.worth.length === 0 && props.model.also.length === 0 && props.model.filedTotal === 0
);
</script>

<template>
	<section aria-labelledby="today-updates">
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

		<div v-else class="rounded-xl border border-border-subtle bg-bg-elevated">
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
							<InboxChip
								v-if="inboxOf(line)"
								:name="inboxOf(line)!.name"
								:slot="inboxOf(line)!.slot"
							/>
							<span
								v-else
								class="inline-flex items-center gap-1 rounded-full bg-bg-surface px-2 py-px text-2xs font-medium text-text-secondary"
								><Icon name="lucide:bot" class="size-3" />{{
									t('components.shell.teamInbox')
								}}</span
							>
						</span>
					</div>
				</template>
			</template>
			<p v-if="model.alsoHidden > 0" class="px-4 pt-1 text-xs text-text-tertiary">
				{{ t('components.today.updates.more', { count: model.alsoHidden }, model.alsoHidden) }}
				<NuxtLink to="/dashboard/inboxes" class="text-brand hover:underline">{{
					t('components.today.openInboxes')
				}}</NuxtLink>
			</p>
			<div
				v-if="filedParts.length > 0"
				class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle px-4 py-2.5 text-xs text-text-tertiary"
			>
				<span>{{ t('components.today.filed.title') }}</span>
				<NuxtLink
					v-for="part in filedParts"
					:key="part.key"
					:to="part.href"
					class="text-text-secondary underline decoration-dotted decoration-text-tertiary/50 underline-offset-[3px] hover:text-text-primary hover:decoration-solid"
					>{{ part.label }}</NuxtLink
				>
				<span class="ml-auto max-md:hidden">{{ t('components.today.filed.reassure') }}</span>
			</div>
			<div v-else class="h-2" />
		</div>
	</section>
</template>
