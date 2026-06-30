<script setup lang="ts">
interface TimelineEvent {
	key: string;
	label: string;
	icon: string;
	colorClasses: string;
	timestamp: number | undefined;
	reached: boolean;
	delta?: string;
	extra?: string;
}

interface ClickedLink {
	url: string;
	clickedAt: number;
}

const props = defineProps<{
	status: string;
	queuedAt?: number;
	sentAt?: number;
	deliveredAt?: number;
	openedAt?: number;
	clickedAt?: number;
	bouncedAt?: number;
	complainedAt?: number;
	openCount?: number;
	clickedLinks?: ClickedLink[];
	errorMessage?: string;
	errorCode?: string;
	providerMessageId?: string;
	dataVariables?: Record<string, unknown>;
	showQueued?: boolean;
}>();

const statusConfig: Record<string, { icon: string; color: string }> = {
	queued: { icon: 'lucide:clock', color: 'bg-bg-surface text-text-secondary' },
	sent: { icon: 'lucide:send', color: 'bg-brand/10 text-brand' },
	delivered: { icon: 'lucide:check-circle-2', color: 'bg-success/10 text-success' },
	opened: { icon: 'lucide:eye', color: 'bg-brand/10 text-brand' },
	clicked: { icon: 'lucide:mouse-pointer-click', color: 'bg-warning/10 text-warning' },
	bounced: { icon: 'lucide:x-circle', color: 'bg-error/10 text-error' },
	complained: { icon: 'lucide:alert-triangle', color: 'bg-error/10 text-error' },
};

const formatTimestamp = (ts: number) => {
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	}).format(new Date(ts));
};

const formatDelta = (fromTs: number, toTs: number): string => {
	const diff = toTs - fromTs;
	if (diff < 0) return '';
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return remainSec > 0 ? `${minutes}m ${remainSec}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainHours = hours % 24;
	return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
};

// Status progression order — bounced/complained branch off
const progressionOrder = ['queued', 'sent', 'delivered', 'opened', 'clicked'];
const errorStatuses = ['bounced', 'complained'];

const timelineEvents = computed<TimelineEvent[]>(() => {
	const events: TimelineEvent[] = [];
	const timestamps: Record<string, number | undefined> = {
		queued: props.queuedAt,
		sent: props.sentAt,
		delivered: props.deliveredAt,
		opened: props.openedAt,
		clicked: props.clickedAt,
		bounced: props.bouncedAt,
		complained: props.complainedAt,
	};

	// Determine the highest reached status in the progression
	const currentStatusIndex = progressionOrder.indexOf(props.status);
	const isError = errorStatuses.includes(props.status);

	// Build normal progression events
	const startIndex = props.showQueued ? 0 : 1;
	let prevTimestamp: number | undefined;

	for (let i = startIndex; i < progressionOrder.length; i++) {
		const key = progressionOrder[i]!;
		const ts = timestamps[key];
		const reached = isError
			? ts != null
			: i <= currentStatusIndex && ts != null;
		const cfg = statusConfig[key]!;

		let delta: string | undefined;
		if (reached && ts && prevTimestamp) {
			const d = formatDelta(prevTimestamp, ts);
			if (d) delta = `${d} after ${progressionOrder[i - 1] === 'queued' ? 'Queued' : events[events.length - 1]?.label || ''}`;
		}

		let extra: string | undefined;
		if (key === 'opened' && reached && props.openCount && props.openCount > 1) {
			extra = `${props.openCount} opens total`;
		}

		events.push({
			key,
			label: key.charAt(0).toUpperCase() + key.slice(1),
			icon: cfg.icon,
			colorClasses: cfg.color,
			timestamp: ts,
			reached,
			delta,
			extra,
		});

		if (reached && ts) {
			prevTimestamp = ts;
		}
	}

	// Add error events if they occurred
	for (const errKey of errorStatuses) {
		const ts = timestamps[errKey];
		if (ts) {
			const cfg = statusConfig[errKey]!;
			let delta: string | undefined;
			if (prevTimestamp) {
				const d = formatDelta(prevTimestamp, ts);
				if (d) delta = `${d} after ${events[events.length - 1]?.label || 'previous'}`;
			}
			events.push({
				key: errKey,
				label: errKey.charAt(0).toUpperCase() + errKey.slice(1),
				icon: cfg.icon,
				colorClasses: cfg.color,
				timestamp: ts,
				reached: true,
				delta,
			});
		}
	}

	return events;
});

const showDataVariables = ref(false);
const { copy, copiedKey } = useCopyToClipboard();
const messageIdCopied = computed(() => copiedKey.value === 'message-id');

const copyMessageId = async () => {
	if (!props.providerMessageId) return;
	await copy(props.providerMessageId, 'message-id');
};
</script>

<template>
	<div class="space-y-6">
		<!-- Timeline -->
		<div class="card p-6">
			<h3 class="text-lg font-medium text-text-primary mb-6">Event Timeline</h3>

			<div class="space-y-1">
				<div
					v-for="(event, index) in timelineEvents"
					:key="event.key"
					class="relative"
				>
					<!-- Timeline connector line -->
					<div
						v-if="index < timelineEvents.length - 1"
						class="absolute left-5 top-10 bottom-0 w-px"
						:class="event.reached && timelineEvents[index + 1]?.reached ? 'bg-border-subtle' : 'border-l border-dashed border-border-subtle'"
					/>

					<!-- Event item -->
					<div class="flex items-start gap-4 py-3">
						<!-- Icon -->
						<div
							class="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
							:class="event.reached ? event.colorClasses : 'bg-bg-surface text-text-tertiary'"
						>
							<Icon :name="event.icon" class="w-5 h-5" />
						</div>

						<!-- Content -->
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<p
									class="text-sm font-medium"
									:class="event.reached ? 'text-text-primary' : 'text-text-tertiary'"
								>
									{{ event.label }}
								</p>
								<span
									v-if="event.delta"
									class="text-xs text-text-tertiary bg-bg-surface px-1.5 py-0.5 rounded"
								>
									{{ event.delta }}
								</span>
							</div>
							<p v-if="event.reached && event.timestamp" class="text-text-secondary text-xs mt-0.5">
								{{ formatTimestamp(event.timestamp) }}
							</p>
							<p v-else-if="!event.reached" class="text-text-tertiary text-xs mt-0.5">
								Not yet reached
							</p>
							<p v-if="event.extra" class="text-text-tertiary text-xs mt-0.5">
								{{ event.extra }}
							</p>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Clicked Links -->
		<div v-if="clickedLinks && clickedLinks.length > 0" class="card p-6">
			<h3 class="text-lg font-medium text-text-primary mb-4">Clicked Links</h3>
			<div class="space-y-3">
				<div
					v-for="(link, index) in clickedLinks"
					:key="index"
					class="flex items-start gap-3 text-sm"
				>
					<Icon name="lucide:external-link" class="w-4 h-4 text-text-tertiary mt-0.5 flex-shrink-0" />
					<div class="min-w-0">
						<a
							:href="link.url"
							target="_blank"
							rel="noopener noreferrer"
							class="text-brand hover:underline break-all"
						>
							{{ link.url }}
						</a>
						<p class="text-text-tertiary text-xs mt-0.5">
							{{ formatTimestamp(link.clickedAt) }}
						</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Error Details -->
		<div v-if="errorMessage || errorCode" class="card p-6 bg-error-subtle border-error/20">
			<div class="flex items-center gap-3 mb-3">
				<Icon name="lucide:alert-triangle" class="w-5 h-5 text-error" />
				<h3 class="text-lg font-medium text-error">Error Details</h3>
			</div>
			<div class="space-y-2 text-sm">
				<p v-if="errorCode" class="text-text-secondary">
					<span class="font-medium">Code:</span> {{ errorCode }}
				</p>
				<p v-if="errorMessage" class="text-text-primary">
					{{ errorMessage }}
				</p>
			</div>
		</div>

		<!-- Provider Message ID -->
		<div v-if="providerMessageId" class="card p-4">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3 min-w-0">
					<Icon name="lucide:hash" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
					<div class="min-w-0">
						<p class="text-xs text-text-tertiary">Provider Message ID</p>
						<p class="text-sm text-text-secondary font-mono truncate">{{ providerMessageId }}</p>
					</div>
				</div>
				<button
					class="btn btn-secondary text-xs gap-1.5 flex-shrink-0"
					@click="copyMessageId"
				>
					<Icon :name="messageIdCopied ? 'lucide:check' : 'lucide:copy'" class="w-3.5 h-3.5" />
					{{ messageIdCopied ? 'Copied' : 'Copy' }}
				</button>
			</div>
		</div>

		<!-- Data Variables (transactional only) -->
		<div v-if="dataVariables && Object.keys(dataVariables).length > 0" class="card p-6">
			<button
				class="flex items-center justify-between w-full text-left"
				@click="showDataVariables = !showDataVariables"
			>
				<div class="flex items-center gap-3">
					<Icon name="lucide:braces" class="w-5 h-5 text-text-tertiary" />
					<h3 class="text-lg font-medium text-text-primary">Data Variables</h3>
				</div>
				<Icon
					name="lucide:chevron-down"
					class="w-5 h-5 text-text-tertiary transition-transform"
					:class="{ 'rotate-180': showDataVariables }"
				/>
			</button>
			<div v-if="showDataVariables" class="mt-4">
				<pre class="text-sm text-text-secondary bg-bg-surface rounded-lg p-4 overflow-x-auto font-mono">{{ JSON.stringify(dataVariables, null, 2) }}</pre>
			</div>
		</div>
	</div>
</template>
