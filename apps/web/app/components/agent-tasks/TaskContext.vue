<script setup lang="ts">
/**
 * The "who / what / when" header of an agent task card: avatar (or icon
 * fallback), who the task is about, a muted meta line, and AT MOST ONE roll-up
 * status chip (+ an optional due chip). Extra context (a trust chip, a channel
 * chip) mounts via the `status` / `chips` slots — the single-status rule is
 * the consumer's contract, this component just makes the default path honor it.
 */
export interface TaskStatusChip {
	label: string;
	icon?: string;
	tone?: 'brand' | 'warning' | 'error' | 'success' | 'neutral';
}

const props = withDefaults(
	defineProps<{
		/** Who the task is about (sender / requester). */
		who: string;
		/** Avatar identity; falls back to `icon` when absent. */
		name?: string;
		email?: string;
		/** Icon shown when there is no avatar identity. */
		icon?: string;
		/** Muted meta line (timestamp etc.) — or use the `meta` slot for rich content. */
		meta?: string;
		/** The one roll-up status chip. */
		status?: TaskStatusChip;
		/** Human due label ("Due Jul 3") — warning-toned, omitted when absent. */
		due?: string;
	}>(),
	{
		name: undefined,
		email: undefined,
		icon: 'lucide:mail',
		meta: undefined,
		status: undefined,
		due: undefined,
	}
);

const TONE_CLASS: Record<NonNullable<TaskStatusChip['tone']>, string> = {
	brand: 'bg-brand/10 text-brand',
	warning: 'bg-warning/10 text-warning',
	error: 'bg-error/10 text-error',
	success: 'bg-success/10 text-success',
	neutral: 'bg-bg-elevated text-text-tertiary',
};

const statusClass = computed(() => TONE_CLASS[props.status?.tone ?? 'brand']);
const hasAvatar = computed(() => Boolean(props.name || props.email));
</script>

<template>
	<div class="flex items-start gap-3" data-testid="task-context">
		<UiAvatar
			v-if="hasAvatar"
			:name="name"
			:email="email"
			deterministic-color
			size="sm"
			class="flex-shrink-0 mt-0.5"
			aria-hidden="true"
		/>
		<UiIconBox v-else :icon="icon" size="sm" variant="surface" rounded="full" />
		<div class="flex-1 min-w-0">
			<div class="flex items-center gap-1.5 flex-wrap">
				<span class="truncate text-sm text-text-secondary">{{ who }}</span>
				<slot name="status">
					<span
						v-if="status"
						data-testid="task-status-chip"
						class="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full"
						:class="statusClass"
					>
						<Icon v-if="status.icon" :name="status.icon" class="w-3 h-3" aria-hidden="true" />
						{{ status.label }}
					</span>
				</slot>
				<span
					v-if="due"
					data-testid="task-due-chip"
					class="flex-shrink-0 text-[10px] font-medium px-1.5 py-px rounded-full bg-warning/10 text-warning"
				>
					{{ due }}
				</span>
				<slot name="chips" />
			</div>
			<div v-if="meta || $slots['meta']" class="text-xs text-text-tertiary mt-0.5">
				<slot name="meta">{{ meta }}</slot>
			</div>
		</div>
		<slot name="trailing" />
	</div>
</template>
