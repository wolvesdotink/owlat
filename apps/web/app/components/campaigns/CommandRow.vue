<script setup lang="ts">
import type { DecoratedRow } from '~/utils/campaignCommandRow';

const props = defineProps<{ row: DecoratedRow }>();

const emit = defineEmits<{
	open: [];
	runAction: [];
	abResults: [];
	duplicate: [];
	delete: [];
}>();

const dropdownOpen = ref(false);

/** Meta line under the campaign name — one human sentence per state. */
const metaLine = computed(() => {
	const row = props.row;
	const c = row.campaign;
	if (row.reason === 'ab_decision') {
		const a = row.variantA;
		const b = row.variantB;
		if (a != null && b != null) {
			const diff = Math.abs(a - b);
			const leader = b >= a ? 'B' : 'A';
			if (diff >= 0.1) return `Variant ${leader} leads by ${diff.toFixed(1)} pts`;
			return 'Variants are running even';
		}
		return 'A/B test in progress';
	}
	if (c.status === 'scheduled') {
		return c.scheduledAt ? `Scheduled for ${formatDateTime(c.scheduledAt)}` : 'Scheduled';
	}
	if (c.status === 'sending') return 'Sending now';
	if (c.status === 'cancelled') return 'Send was stopped';
	if (c.status === 'sent') {
		const recipients = c.statsDelivered ?? c.statsSent ?? 0;
		return `Sent ${formatDate(c.sentAt)} · ${recipients.toLocaleString()} recipients`;
	}
	if (c.status === 'pending_review') {
		return `Awaiting review · updated ${formatCompactRelativeTime(c.updatedAt)}`;
	}
	return `Draft · updated ${formatCompactRelativeTime(c.updatedAt)}`;
});
</script>

<template>
	<li
		class="group flex items-center gap-4 px-4 sm:px-6 py-4 hover:bg-bg-surface transition-colors duration-(--motion-fast) ease-spring cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
		tabindex="0"
		role="link"
		:aria-label="`Open ${row.campaign.name}`"
		@click="emit('open')"
		@keydown.enter="emit('open')"
		@keydown.space.prevent="emit('open')"
	>
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2 min-w-0">
				<span
					:class="[
						'truncate text-text-primary',
						row.needsAttention ? 'font-semibold' : 'font-medium',
					]"
				>
					{{ row.campaign.name }}
				</span>
				<span
					v-if="row.campaign.isABTest"
					class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-text-secondary bg-bg-elevated shrink-0"
					title="A/B test"
				>
					<Icon name="lucide:split" class="w-3 h-3" />
					A/B
				</span>
			</div>

			<div class="flex items-center gap-2 mt-1 min-w-0">
				<!-- One roll-up chip: attention reason when present, else status -->
				<span
					v-if="row.reasonChip"
					class="inline-flex items-center gap-1.5 text-xs text-text-secondary shrink-0"
				>
					<span :class="['w-1.5 h-1.5 rounded-full', row.reasonChip.dot]" />
					{{ row.reasonChip.label }}
				</span>
				<span
					v-else
					:class="[
						'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium shrink-0',
						row.statusBadge.color,
					]"
				>
					<Icon
						:name="row.statusBadge.icon"
						:class="['w-3 h-3', row.campaign.status === 'sending' ? 'animate-spin' : '']"
					/>
					{{ row.statusBadge.label }}
				</span>
				<span class="text-xs text-text-tertiary truncate">{{ metaLine }}</span>
			</div>
		</div>

		<!-- Sparkline (A/B variant open-rate trend; hidden otherwise) -->
		<UiSparkline
			v-if="row.spark.length >= 2"
			:data="row.spark"
			:ariaLabel="`Variant open-rate trend for ${row.campaign.name}`"
			class="hidden md:inline-block shrink-0"
		/>

		<div class="hidden sm:flex items-center gap-6 shrink-0">
			<div class="text-right w-16">
				<p class="text-sm font-semibold tabular-nums text-text-primary">
					{{ row.openRate != null ? `${row.openRate.toFixed(1)}%` : '—' }}
				</p>
				<p class="text-[11px] text-text-tertiary">Open</p>
			</div>
			<div class="text-right w-16">
				<p class="text-sm font-semibold tabular-nums text-text-primary">
					{{ row.clickRate != null ? `${row.clickRate.toFixed(1)}%` : '—' }}
				</p>
				<p class="text-[11px] text-text-tertiary">Click</p>
			</div>
		</div>

		<!-- Primary action (attention verb / A/B results / view) + overflow -->
		<div
			class="shrink-0 flex items-center justify-end gap-1"
			@click.stop
			@keydown.enter.stop
			@keydown.space.stop
		>
			<UiButton v-if="row.actionLabel" size="sm" variant="secondary" @click="emit('runAction')">
				{{ row.actionLabel }}
			</UiButton>
			<!-- Completed A/B tests keep a discoverable path to their results -->
			<button
				v-else-if="row.campaign.isABTest"
				class="text-xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand rounded px-1 py-1"
				@click="emit('abResults')"
			>
				A/B results
			</button>
			<button
				v-else
				class="ui-hover-reveal p-2 rounded-lg text-text-tertiary hover:text-brand transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
				title="View campaign"
				aria-label="View campaign"
				@click="emit('open')"
			>
				<Icon name="lucide:arrow-right" class="w-4 h-4" />
			</button>

			<!-- Row overflow: Duplicate + Delete (preserved from the old list) -->
			<UiDropdownMenu v-model:open="dropdownOpen">
				<template #trigger>
					<button
						class="ui-hover-reveal p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
						aria-label="More actions"
					>
						<Icon name="lucide:more-vertical" class="w-4 h-4" />
					</button>
				</template>
				<UiDropdownMenuItem icon="lucide:copy" @click="emit('duplicate')">
					Duplicate
				</UiDropdownMenuItem>
				<UiDropdownDivider v-if="row.campaign.status !== 'sending'" />
				<UiDropdownMenuItem
					v-if="row.campaign.status !== 'sending'"
					icon="lucide:trash-2"
					danger
					@click="emit('delete')"
				>
					Delete
				</UiDropdownMenuItem>
			</UiDropdownMenu>
		</div>
	</li>
</template>
