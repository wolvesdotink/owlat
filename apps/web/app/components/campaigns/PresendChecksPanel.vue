<script setup lang="ts">
/**
 * The pre-send checks, listed: what needs a look first (blocking, warnings,
 * checks still running or unable to run), the passes folded away beneath.
 * Each finding can point at the Block it lives in ("Show me").
 *
 * Presentational: the checks come from `usePresendChecks`, and the host
 * decides what "Show me" does (open the editor on the Block from the Review
 * step, select it in place from the editor) and what acknowledging warnings
 * changes (the Review step's send button stops saying "Send anyway").
 */
import type { PresendSummary } from '~/lib/presendChecks/checks';
import type { PresendCheck, PresendStatus } from '~/lib/presendChecks/types';

const props = withDefaults(
	defineProps<{
		checks: readonly PresendCheck[];
		summary: PresendSummary;
		isChecking: boolean;
		/** Offer "Mark as reviewed" for the current warnings. */
		acknowledgeable?: boolean;
		acknowledged?: boolean;
		/** Inside a dialog that is already the card. */
		embedded?: boolean;
	}>(),
	{ acknowledgeable: false, acknowledged: false, embedded: false }
);

const emit = defineEmits<{
	retry: [];
	acknowledge: [];
	showBlock: [blockId: string];
}>();

const { t, te } = useI18n();

/** A URL, file name or colour pair is shown as code; a worded label is not. */
const isVerbatim = (label: PresendCheck['items'][number]['label']) =>
	typeof label === 'string' && !te(label) && !te(label, 'en');
const localized = useLocalized();

const KEY = 'components.campaigns.presendChecks';
/** Findings shown per check before "Show all". */
const ITEM_PREVIEW = 4;

const ORDER: Record<PresendStatus, number> = {
	blocking: 0,
	warning: 1,
	pending: 2,
	skipped: 3,
	pass: 4,
};

const attention = computed(() =>
	props.checks
		.filter((check) => check.status !== 'pass')
		.slice()
		.sort((a, b) => ORDER[a.status] - ORDER[b.status])
);
const passed = computed(() => props.checks.filter((check) => check.status === 'pass'));
const showPassed = ref(false);
const expanded = ref(new Set<string>());

function toggleItems(id: string) {
	const next = new Set(expanded.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expanded.value = next;
}

const visibleItems = (check: PresendCheck) =>
	expanded.value.has(check.id) ? check.items : check.items.slice(0, ITEM_PREVIEW);

const STATUS_ICON: Record<PresendStatus, { name: string; tone: string }> = {
	blocking: { name: 'lucide:octagon-x', tone: 'text-error' },
	warning: { name: 'lucide:triangle-alert', tone: 'text-warning' },
	pending: {
		name: 'lucide:loader-circle',
		tone: 'text-text-tertiary animate-spin motion-reduce:animate-none',
	},
	skipped: { name: 'lucide:circle-minus', tone: 'text-text-tertiary' },
	pass: { name: 'lucide:circle-check', tone: 'text-success' },
};

const headline = computed(() => {
	const { blocking, warnings } = props.summary;
	if (blocking > 0) return t(`${KEY}.headline.blocked`);
	if (warnings > 0) return t(`${KEY}.headline.warnings`, { count: warnings }, warnings);
	if (props.isChecking) return t(`${KEY}.headline.checking`);
	return t(`${KEY}.headline.clear`);
});
</script>

<template>
	<section
		:class="embedded ? undefined : 'card p-6'"
		data-testid="presend-checks"
		:aria-busy="isChecking"
	>
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h3 v-if="!embedded" class="text-lg font-semibold text-text-primary">
					{{ t(`${KEY}.title`) }}
				</h3>
				<p class="mt-1 text-sm text-text-secondary" data-testid="presend-headline">
					{{ headline }}
				</p>
			</div>
			<UiButton
				variant="secondary"
				size="sm"
				:loading="isChecking"
				:disabled="isChecking"
				data-testid="presend-recheck"
				@click="emit('retry')"
			>
				<template v-if="!isChecking" #iconLeft>
					<Icon name="lucide:refresh-cw" class="h-4 w-4" />
				</template>
				{{ t(`${KEY}.recheck`) }}
			</UiButton>
		</div>

		<ul class="mt-4 space-y-3">
			<li
				v-for="check in attention"
				:key="check.id"
				class="rounded-lg bg-bg-surface p-3 shadow-surface-1"
				:data-testid="`presend-check-${check.id}`"
				:data-status="check.status"
			>
				<div class="flex items-start gap-3">
					<Icon
						:name="STATUS_ICON[check.status].name"
						class="mt-0.5 h-5 w-5 shrink-0"
						:class="STATUS_ICON[check.status].tone"
					/>
					<div class="min-w-0 flex-1">
						<p class="text-xs font-medium uppercase tracking-wide text-text-tertiary">
							{{ t(`${KEY}.names.${check.id}`) }}
						</p>
						<p class="mt-0.5 text-sm text-text-primary">{{ localized(check.summary) }}</p>
						<p v-if="check.note" class="mt-0.5 text-sm text-text-secondary">
							{{ localized(check.note) }}
						</p>
						<ul v-if="check.items.length > 0" class="mt-2 space-y-1.5">
							<li
								v-for="(item, index) in visibleItems(check)"
								:key="index"
								class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm"
							>
								<span class="min-w-0 max-w-full">
									<span
										class="break-all text-text-primary"
										:class="isVerbatim(item.label) ? 'font-mono text-xs' : 'font-medium'"
										>{{ localized(item.label) }}</span
									>
									<span class="text-text-secondary"> · {{ localized(item.reason) }}</span>
								</span>
								<button
									v-if="item.blockId"
									type="button"
									class="shrink-0 text-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
									data-testid="presend-show-block"
									@click="emit('showBlock', item.blockId)"
								>
									{{ t(`${KEY}.showMe`) }}
								</button>
							</li>
						</ul>
						<button
							v-if="check.items.length > ITEM_PREVIEW"
							type="button"
							class="mt-1.5 text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
							@click="toggleItems(check.id)"
						>
							{{
								expanded.has(check.id)
									? t(`${KEY}.showFewer`)
									: t(`${KEY}.showAll`, { count: check.items.length })
							}}
						</button>
					</div>
				</div>
			</li>
		</ul>

		<div v-if="passed.length > 0" class="mt-3">
			<button
				type="button"
				class="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
				:aria-expanded="showPassed"
				data-testid="presend-toggle-passed"
				@click="showPassed = !showPassed"
			>
				<Icon
					name="lucide:chevron-right"
					class="h-4 w-4 transition-transform"
					:class="showPassed && 'rotate-90'"
				/>
				{{ t(`${KEY}.passed`, { count: passed.length }, passed.length) }}
			</button>
			<ul v-if="showPassed" class="mt-2 space-y-1.5 pl-6">
				<li
					v-for="check in passed"
					:key="check.id"
					class="flex items-start gap-2 text-sm"
					:data-testid="`presend-check-${check.id}`"
					data-status="pass"
				>
					<Icon name="lucide:circle-check" class="mt-0.5 h-4 w-4 shrink-0 text-success" />
					<span class="text-text-secondary">
						<span class="text-text-primary">{{ t(`${KEY}.names.${check.id}`) }}:</span>
						{{ localized(check.summary) }}
						<template v-if="check.note"> {{ localized(check.note) }}</template>
					</span>
				</li>
			</ul>
		</div>

		<div
			v-if="acknowledgeable && summary.warnings > 0 && summary.blocking === 0"
			class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3"
			data-testid="presend-acknowledge"
		>
			<p class="text-sm text-text-primary">
				{{ acknowledged ? t(`${KEY}.acknowledged`) : t(`${KEY}.warningsDontBlock`) }}
			</p>
			<UiButton v-if="!acknowledged" variant="secondary" size="sm" @click="emit('acknowledge')">
				<template #iconLeft><Icon name="lucide:check" class="h-4 w-4" /></template>
				{{ t(`${KEY}.markReviewed`) }}
			</UiButton>
		</div>
	</section>
</template>
