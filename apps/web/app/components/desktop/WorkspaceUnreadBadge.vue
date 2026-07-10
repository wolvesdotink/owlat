<script setup lang="ts">
/**
 * Per-workspace unread count badge, shared by the Slack-style rail
 * (WorkspaceSwitcher) and the titlebar switcher menu (WorkspaceMenu) so the
 * count markup + the >99 clamp live in one place. Styled on the FF --color-error
 * token (never a raw Tailwind palette colour); the caller positions it.
 */
interface Props {
	/** Unread count; the badge renders nothing when this is <= 0. */
	count: number;
}
const props = defineProps<Props>();

/** Clamp large counts to a fixed-width label so the pill never grows unbounded. */
const label = computed(() => (props.count > 99 ? '99+' : String(props.count)));
</script>

<template>
	<span
		v-if="count > 0"
		class="min-w-4 h-4 px-1 rounded-full bg-error text-text-inverse text-[10px] font-semibold flex items-center justify-center shrink-0 tabular-nums"
	>
		{{ label }}
	</span>
</template>
