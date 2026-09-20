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

const { t } = useI18n();

const showLogs = ref(false);
const logEl = ref<HTMLElement | null>(null);

/**
 * The installer streams thousands of lines and the composable keeps a deep
 * scrollback (5000) so a failing build's root cause survives. Painting all of
 * it is what made this pane jerky: only the tail is rendered, the rest is
 * trimmed, and the pane scrolls within its own box over what remains.
 */
const VISIBLE_TAIL_LINES = 500;
/** Treat "within a line or two of the end" as still at the bottom. */
const AT_BOTTOM_SLACK_PX = 24;

const visibleLogs = computed(() => props.logs.slice(-VISIBLE_TAIL_LINES));
const trimmedCount = computed(() => props.logs.length - visibleLogs.value.length);

/**
 * Follow the tail only while the reader is parked at the bottom. Scrolling up
 * to read a stack trace has to stay put — yanking the view back on every new
 * line is what made the log unreadable during a long install.
 */
const following = ref(true);

function scrollToBottom(): void {
	const el = logEl.value;
	if (el) el.scrollTop = el.scrollHeight;
}

function onLogScroll(): void {
	const el = logEl.value;
	if (!el) return;
	following.value = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX;
}

async function jumpToLatest(): Promise<void> {
	following.value = true;
	await nextTick();
	scrollToBottom();
}

/** Group → message key; an unknown group falls back to its raw name. */
const GROUP_LABEL_KEYS: Record<string, string> = {
	connect: 'components.desktop.provisioningTimeline.groups.connect',
	server: 'components.desktop.provisioningTimeline.groups.server',
	finish: 'components.desktop.provisioningTimeline.groups.finish',
};

// Inject a header row whenever the group changes.
type Row = { kind: 'header'; label: string } | { kind: 'step'; step: TimelineStep };
const rows = computed<Row[]>(() => {
	const out: Row[] = [];
	let group = '';
	for (const step of props.steps) {
		if (step.group !== group) {
			group = step.group;
			const labelKey = GROUP_LABEL_KEYS[group];
			out.push({ kind: 'header', label: labelKey ? t(labelKey) : group });
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
		if (!showLogs.value || !following.value) return;
		await nextTick();
		scrollToBottom();
	}
);

// Opening the drawer lands on the newest output, following again.
watch(showLogs, async (open) => {
	if (!open) return;
	following.value = true;
	await nextTick();
	scrollToBottom();
});
</script>

<template>
	<div class="space-y-4">
		<!-- progress bar -->
		<UiProgressBar
			size="sm"
			:value="progress"
			:aria-label="t('components.desktop.provisioningTimeline.progressLabel')"
		/>

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
						:class="[
							COLOR[row.step.state],
							row.step.state === 'running' ? 'animate-spin motion-reduce:animate-none' : '',
						]"
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
						{{ t(row.step.title) }}
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
					{{ t('components.desktop.provisioningTimeline.serverLog') }}
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
					class="relative max-h-64 overflow-hidden border-t border-border-default bg-bg-deep"
				>
					<div
						ref="logEl"
						role="log"
						tabindex="0"
						:aria-label="t('components.desktop.provisioningTimeline.logRegionLabel')"
						class="max-h-64 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[11px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
						@scroll.passive="onLogScroll"
					>
						<p v-if="!logs.length" class="text-text-secondary/60">
							{{ t('components.desktop.provisioningTimeline.waitingForOutput') }}
						</p>
						<!-- Only the tail is painted; say so rather than pretending this is the whole run. -->
						<p
							v-if="trimmedCount > 0"
							class="mb-1 border-b border-border-subtle pb-1 text-text-secondary/60"
						>
							{{ t('components.desktop.provisioningTimeline.trimmed', trimmedCount) }}
						</p>
						<p
							v-for="(l, i) in visibleLogs"
							:key="trimmedCount + i"
							class="whitespace-pre-wrap break-all"
							:class="l.stream === 'stderr' ? 'text-warning/80' : 'text-text-secondary'"
						>
							{{ l.line }}
						</p>
					</div>
					<!-- Scrolled up to read something? The tail stops chasing until you come back. -->
					<button
						v-if="!following"
						type="button"
						class="absolute bottom-2 right-3 flex items-center gap-1 rounded-full border border-border-default bg-bg-surface px-2.5 py-1 text-[11px] text-text-secondary shadow-sm transition-colors duration-(--motion-fast) hover:text-text-primary"
						@click="jumpToLatest"
					>
						<Icon name="lucide:arrow-down" class="size-3" />
						{{ t('components.desktop.provisioningTimeline.jumpToLatest') }}
					</button>
				</div>
			</Transition>
		</div>
	</div>
</template>
