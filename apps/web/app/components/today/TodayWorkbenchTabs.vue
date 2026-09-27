<script setup lang="ts">
import { INBOX_SLOT_SWATCH } from '~/utils/inboxIdentity';
import type { WorkbenchScope, WorkbenchTab } from '~/utils/workbench';

/**
 * The Workbench's tab row: one tab per inbox (and the team inbox). A tab
 * carries the inbox's colour and name, a solid badge for what waits on the
 * viewer's answer there, or else a quiet unread count, so the row alone says
 * where to go next. Keyboard follows the ARIA tabs pattern: ←/→ (and Home/End)
 * move between tabs and select them.
 */
const props = defineProps<{
	tabs: readonly WorkbenchTab[];
	selected: WorkbenchScope | null;
	/** The page's tab panel; only the open tab's panel exists, so only it points there. */
	panelId?: string;
}>();
const emit = defineEmits<{ select: [scope: WorkbenchScope] }>();
const { t } = useI18n();

const list = ref<HTMLElement | null>(null);

// On a narrow screen the row scrolls sideways; a fade on the cut edge says so.
const overflowsRight = ref(false);
function measure() {
	const el = list.value;
	if (!el) return;
	overflowsRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}
function revealSelected() {
	list.value
		?.querySelector<HTMLElement>('[aria-selected="true"]')
		?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
onMounted(() => {
	measure();
	revealSelected();
	window.addEventListener('resize', measure);
});
onBeforeUnmount(() => window.removeEventListener('resize', measure));
watch(
	() => [props.tabs.length, props.selected],
	() =>
		void nextTick(() => {
			revealSelected();
			measure();
		})
);

function swatch(slot: number | null): string {
	return slot === null ? 'bg-text-tertiary' : (INBOX_SLOT_SWATCH[slot] ?? 'bg-text-tertiary');
}

function onKeydown(event: KeyboardEvent) {
	const index = props.tabs.findIndex((tab) => tab.scope === props.selected);
	const last = props.tabs.length - 1;
	const next =
		event.key === 'ArrowRight'
			? Math.min(last, index + 1)
			: event.key === 'ArrowLeft'
				? Math.max(0, index - 1)
				: event.key === 'Home'
					? 0
					: event.key === 'End'
						? last
						: null;
	if (next === null || next === index) return;
	event.preventDefault();
	const tab = props.tabs[next];
	if (!tab) return;
	emit('select', tab.scope);
	void nextTick(() =>
		list.value?.querySelector<HTMLElement>(`[data-workbench-tab="${tab.scope}"]`)?.focus()
	);
}
</script>

<template>
	<!-- On a phone the actions sit above the row, so every tab keeps the full width. -->
	<div
		class="flex flex-col-reverse gap-1 border-b border-border-subtle sm:flex-row sm:items-end sm:gap-2"
	>
		<div
			ref="list"
			role="tablist"
			:aria-label="t('components.today.tabs.label')"
			class="-mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto"
			:class="
				overflowsRight
					? '[mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)]'
					: ''
			"
			@keydown="onKeydown"
			@scroll.passive="measure"
		>
			<button
				v-for="tab in tabs"
				:id="`workbench-tab-${tab.scope}`"
				:key="tab.scope"
				type="button"
				role="tab"
				:aria-selected="tab.scope === selected"
				:aria-controls="tab.scope === selected ? panelId : undefined"
				:tabindex="tab.scope === selected ? 0 : -1"
				:title="tab.address ?? undefined"
				:data-workbench-tab="tab.scope"
				class="relative flex shrink-0 items-center gap-1.5 rounded-t-lg px-2 pb-2.5 sm:gap-2 sm:px-3 pt-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
				:class="
					tab.scope === selected
						? 'text-text-primary'
						: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary'
				"
				@click="emit('select', tab.scope)"
			>
				<Icon v-if="tab.isTeam" name="lucide:bot" class="size-3.5 text-text-tertiary" />
				<span
					v-else
					class="size-2 shrink-0 rounded-[2px]"
					:class="swatch(tab.slot)"
					aria-hidden="true"
				/>
				<span class="max-w-40 truncate">{{ tab.name }}</span>
				<span
					v-if="tab.answer > 0"
					class="rounded-full bg-text-primary px-1.5 text-2xs font-semibold leading-4 text-text-inverse tabular-nums"
					:aria-label="t('components.today.tabs.answer', { count: tab.answer }, tab.answer)"
					>{{ tab.answer > 99 ? '99+' : tab.answer }}</span
				>
				<span
					v-else-if="tab.unread > 0"
					class="text-2xs font-normal tabular-nums text-text-tertiary"
					:aria-label="t('components.today.tabs.unread', { count: tab.unread }, tab.unread)"
					>{{ tab.unread > 99 ? '99+' : tab.unread }}</span
				>
				<span
					v-if="tab.scope === selected"
					class="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand"
					aria-hidden="true"
				/>
			</button>
		</div>
		<div class="flex shrink-0 items-center justify-end pb-1.5 empty:hidden">
			<slot name="end" />
		</div>
	</div>
</template>
