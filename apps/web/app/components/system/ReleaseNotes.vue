<script setup lang="ts">
// What a release changes, as the update card shows it: the summary, then the
// changes grouped by kind. Install instructions are left to the update guide
// (see utils/releaseNotes.ts for what is parsed and what is dropped).
import type { ReleaseChangeKind, ReleaseNotes } from '~/utils/releaseNotes';

const props = defineProps<{ notes: ReleaseNotes; version: string }>();

const { t } = useI18n();

/** Entries shown per group before "Show all". */
const COLLAPSED_ITEMS = 5;
/** Groups that only appear once the list is expanded. */
const MINOR_KINDS = new Set<ReleaseChangeKind>(['docs', 'maintenance', 'other']);

const KIND_STYLE: Record<ReleaseChangeKind, { icon: string; tone: string }> = {
	breaking: { icon: 'lucide:alert-triangle', tone: 'bg-error/10 text-error' },
	security: { icon: 'lucide:shield-check', tone: 'bg-warning/10 text-warning' },
	added: { icon: 'lucide:sparkles', tone: 'bg-brand/10 text-brand' },
	changed: { icon: 'lucide:trending-up', tone: 'bg-info/10 text-info' },
	fixed: { icon: 'lucide:wrench', tone: 'bg-success/10 text-success' },
	removed: { icon: 'lucide:minus-circle', tone: 'bg-bg-surface text-text-secondary' },
	docs: { icon: 'lucide:book-open', tone: 'bg-bg-surface text-text-secondary' },
	maintenance: { icon: 'lucide:settings-2', tone: 'bg-bg-surface text-text-secondary' },
	other: { icon: 'lucide:circle-dot', tone: 'bg-bg-surface text-text-secondary' },
};

const expanded = ref(false);

const visibleGroups = computed(() =>
	props.notes.groups
		.filter((group) => expanded.value || !MINOR_KINDS.has(group.kind))
		.map((group) => ({
			...group,
			shown: expanded.value ? group.items : group.items.slice(0, COLLAPSED_ITEMS),
		}))
);

const hiddenCount = computed(() => {
	const total = props.notes.groups.reduce((n, group) => n + group.items.length, 0);
	const shown = visibleGroups.value.reduce((n, group) => n + group.shown.length, 0);
	return total - shown;
});
</script>

<template>
	<section class="space-y-5">
		<h4 class="text-base font-semibold text-text-primary">
			{{ t('dashboard.admin.system.index.updates.whatsNew', { version }) }}
		</h4>

		<div v-if="notes.summary.length" class="space-y-2 text-sm leading-relaxed text-text-secondary">
			<template v-for="(block, bi) in notes.summary" :key="bi">
				<p v-if="block.type === 'paragraph'"><AssistantInline :inlines="block.inlines" /></p>
				<ul v-else class="list-disc pl-5 space-y-1">
					<li v-for="(item, ii) in block.items" :key="ii"><AssistantInline :inlines="item" /></li>
				</ul>
			</template>
		</div>

		<div v-for="group in visibleGroups" :key="group.kind" class="space-y-2.5">
			<div class="flex items-center gap-2">
				<span
					class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
					:class="KIND_STYLE[group.kind].tone"
				>
					<Icon :name="KIND_STYLE[group.kind].icon" class="w-3.5 h-3.5" aria-hidden="true" />
					{{ t(`dashboard.admin.system.index.updates.kinds.${group.kind}`) }}
				</span>
				<span class="text-caption text-text-tertiary tabular-nums">{{ group.items.length }}</span>
			</div>
			<ul class="release-notes-list space-y-2 text-sm leading-relaxed text-text-secondary">
				<li v-for="(item, ii) in group.shown" :key="ii" class="relative pl-4">
					<AssistantInline :inlines="item" />
				</li>
			</ul>
		</div>

		<UiButton
			v-if="hiddenCount > 0 || expanded"
			variant="ghost"
			size="sm"
			:aria-expanded="expanded"
			@click="expanded = !expanded"
		>
			<Icon
				:name="expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'"
				class="w-4 h-4"
				aria-hidden="true"
			/>
			{{
				expanded
					? t('dashboard.admin.system.index.updates.showFewer')
					: t('dashboard.admin.system.index.updates.showAll', { count: hiddenCount })
			}}
		</UiButton>
	</section>
</template>

<style scoped>
.release-notes-list li::before {
	content: '';
	position: absolute;
	left: 0.25rem;
	top: 0.6em;
	width: 0.3125rem;
	height: 0.3125rem;
	border-radius: 9999px;
	background: var(--color-border-strong, currentColor);
}

/* Bold lead sentences carry the change; the rest explains it. */
.release-notes-list :deep(strong) {
	color: var(--color-text-primary);
	font-weight: 500;
}

/* PR references: present, not loud. */
.release-notes-list :deep(a) {
	color: var(--color-text-tertiary);
	text-decoration: none;
}
.release-notes-list :deep(a:hover) {
	color: var(--color-brand);
	text-decoration: underline;
}
</style>
