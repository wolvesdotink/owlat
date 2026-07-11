<script setup lang="ts">
/**
 * Animated provisioning timeline for the desktop "set up a new server" wizard.
 * Shows the full roadmap up-front (pending → running → done) so the user can see
 * what's been provisioned, what's happening now, and what's still to come, with
 * a collapsible live log drawer underneath.
 */
import type { TimelineStep, StepState } from '~/lib/desktop/provisioning';
import type { LogLine } from '~/composables/useServerProvisioning';

const props = defineProps<{
	steps: TimelineStep[];
	logs: LogLine[];
	progress: number;
}>();

const showLogs = ref(false);
const logEl = ref<HTMLElement | null>(null);

const GROUP_LABELS: Record<string, string> = {
	connect: 'Connect',
	server: 'Provision',
	finish: 'Finish',
};

// Inject a header row whenever the group changes.
type Row = { kind: 'header'; label: string } | { kind: 'step'; step: TimelineStep };
const rows = computed<Row[]>(() => {
	const out: Row[] = [];
	let group = '';
	for (const step of props.steps) {
		if (step.group !== group) {
			group = step.group;
			out.push({ kind: 'header', label: GROUP_LABELS[group] ?? group });
		}
		out.push({ kind: 'step', step });
	}
	return out;
});

const ICON: Record<StepState, string> = {
	pending: 'lucide:circle',
	running: 'lucide:loader-2',
	ok: 'lucide:check-circle-2',
	warn: 'lucide:alert-triangle',
	failed: 'lucide:x-circle',
	skipped: 'lucide:minus-circle',
};

const COLOR: Record<StepState, string> = {
	pending: 'text-text-secondary/50',
	running: 'text-brand',
	ok: 'text-success',
	warn: 'text-warning',
	failed: 'text-error',
	skipped: 'text-text-secondary',
};

watch(
	() => props.logs.length,
	async () => {
		if (!showLogs.value) return;
		await nextTick();
		if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
	}
);
</script>

<template>
	<div class="space-y-4">
		<!-- progress bar -->
		<UiProgressBar size="sm" :value="progress" aria-label="Server provisioning progress" />

		<ol class="space-y-0.5">
			<template v-for="(row, i) in rows" :key="i">
				<li
					v-if="row.kind === 'header'"
					class="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary first:pt-0"
				>
					{{ row.label }}
				</li>
				<li
					v-else
					class="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-(--motion-moderate)"
					:class="row.step.state === 'running' ? 'bg-bg-surface' : ''"
				>
					<Icon
						:name="ICON[row.step.state]"
						class="size-[18px] shrink-0 transition-colors duration-(--motion-moderate)"
						:class="[COLOR[row.step.state], row.step.state === 'running' ? 'animate-spin' : '']"
					/>
					<span
						class="flex-1 text-sm transition-colors duration-(--motion-moderate)"
						:class="
							row.step.state === 'pending'
								? 'text-text-secondary'
								: row.step.state === 'failed'
									? 'text-error'
									: 'text-text-primary'
						"
					>
						{{ row.step.title }}
					</span>
					<span
						v-if="row.step.detail"
						class="max-w-[45%] truncate text-right text-xs text-text-secondary"
						:title="row.step.detail"
					>
						{{ row.step.detail }}
					</span>
				</li>
			</template>
		</ol>

		<!-- live log drawer -->
		<div class="rounded-lg border border-border-default">
			<button
				type="button"
				class="flex w-full items-center justify-between px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
				@click="showLogs = !showLogs"
			>
				<span class="flex items-center gap-1.5">
					<Icon
						:name="showLogs ? 'lucide:chevron-down' : 'lucide:chevron-right'"
						class="size-3.5"
					/>
					Server log
					<span class="text-text-secondary/60">({{ logs.length }})</span>
				</span>
			</button>
			<Transition
				enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 max-h-0"
				enter-to-class="opacity-100 max-h-64"
				leave-active-class="transition-all duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 max-h-64"
				leave-to-class="opacity-0 max-h-0"
			>
				<div
					v-if="showLogs"
					ref="logEl"
					class="max-h-64 overflow-auto border-t border-border-default bg-bg-deep px-3 py-2 font-mono text-[11px] leading-relaxed"
				>
					<p v-if="!logs.length" class="text-text-secondary/60">Waiting for output…</p>
					<p
						v-for="(l, i) in logs"
						:key="i"
						class="whitespace-pre-wrap break-all"
						:class="l.stream === 'stderr' ? 'text-amber-400/80' : 'text-text-secondary'"
					>
						{{ l.line }}
					</p>
				</div>
			</Transition>
		</div>
	</div>
</template>
