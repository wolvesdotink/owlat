<script setup lang="ts">
import { FILED_CATEGORIES } from '@owlat/shared/threadStatus';
import { MAIL_CATEGORY_META } from '~/utils/mailCategory';
import type { TodayModel } from '~/utils/todayDigest';
import { filedHref, type WorkbenchScope } from '~/utils/workbench';

/**
 * "Filed away": the mail a Workbench deliberately does not list —
 * newsletters, notifications, receipts, promotions, spam — as one tile per
 * kind with its count and the first few senders ("The Verge, Stratechery and
 * others"). Each tile opens exactly that list in this inbox, so nothing hides
 * silently; kinds with nothing new stay out of the way.
 */
const props = defineProps<{
	model: Pick<TodayModel, 'filed' | 'filedSenders' | 'filedTotal'>;
	scope: WorkbenchScope;
}>();
const { t } = useI18n();

const tiles = computed(() =>
	FILED_CATEGORIES.filter((key) => props.model.filed[key] > 0).map((key) => {
		const count = props.model.filed[key];
		const senders = props.model.filedSenders[key] ?? [];
		const names = senders.join(', ');
		return {
			key,
			icon: MAIL_CATEGORY_META[key].icon,
			count,
			label: t(`components.today.filed.kind.${key}`, { count }, count),
			from:
				senders.length === 0
					? ''
					: count > senders.length
						? t('components.today.filed.fromMore', { names })
						: t('components.today.filed.from', { names }),
			href: filedHref(props.scope, key),
		};
	})
);
</script>

<template>
	<section id="workbench-filed" aria-labelledby="today-filed">
		<h3
			id="today-filed"
			class="mb-2 mt-8 flex items-baseline gap-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{ t('components.today.filed.title') }}
			<span class="normal-case tracking-normal">{{ t('components.today.filed.reassure') }}</span>
		</h3>
		<p
			v-if="tiles.length === 0"
			class="rounded-xl border border-dashed border-border-subtle px-4 py-4 text-sm text-text-secondary"
		>
			{{ t('components.today.filed.empty') }}
		</p>
		<ul v-else class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]">
			<li v-for="tile in tiles" :key="tile.key">
				<NuxtLink
					:to="tile.href"
					class="group flex h-full flex-col gap-1.5 rounded-xl border border-border-subtle bg-bg-elevated px-3.5 py-3 transition-colors hover:border-border-default hover:bg-bg-surface"
					:data-filed-kind="tile.key"
				>
					<span class="flex items-center justify-between gap-2">
						<Icon
							:name="tile.icon"
							class="size-4 text-text-tertiary group-hover:text-text-secondary"
						/>
						<Icon
							name="lucide:arrow-up-right"
							class="size-3.5 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
						/>
					</span>
					<span class="flex items-baseline gap-1.5">
						<span class="text-xl font-medium tabular-nums text-text-primary">{{ tile.count }}</span>
						<span class="text-xs text-text-secondary">{{ tile.label }}</span>
					</span>
					<span v-if="tile.from" class="text-2xs leading-snug text-text-tertiary">{{
						tile.from
					}}</span>
				</NuxtLink>
			</li>
		</ul>
	</section>
</template>
