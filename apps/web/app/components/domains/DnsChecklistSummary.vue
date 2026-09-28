<script setup lang="ts">
/**
 * The top of the sending-records checklist: how many records are in place, a
 * link to EACH record still outstanding (by its own name — "DKIM 2", not
 * "DKIM"), and one button that copies exactly those records as zone-file lines,
 * for a DNS host's import box or for whoever manages the DNS.
 *
 * Everything shown is derived from the same `ChecklistEntry[]` the rows render,
 * so the count, the links and the rows cannot disagree.
 */
import {
	summarizeChecklist,
	toZoneFileLines,
	type ChecklistEntry,
} from '~/utils/dnsRecordChecklist';
// Explicit import so the summary also mounts inside the row's component tests.
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';

const props = defineProps<{
	entries: ChecklistEntry[];
	domain: string;
	/** Anchor id for an entry's row, so the links land on the right card. */
	anchorFor: (entry: ChecklistEntry) => string;
	/** Per-entry value swaps for the copied text (the merged SPF record). */
	valueOverrides?: Partial<Record<string, string>>;
	/** Per-entry comments the copied text carries above a record (already localized). */
	notes?: Partial<Record<string, string>>;
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

const summary = computed(() => summarizeChecklist(props.entries));

/** Which records the button copies: the outstanding ones, or all once done. */
const copyTargets = computed(() =>
	summary.value.allVerified ? props.entries : summary.value.outstanding
);

// Before the first check every record is outstanding, so "all" is the honest name.
const copyLabel = computed(() => {
	if (summary.value.allVerified || !summary.value.checked) {
		return t('components.domains.dnsChecklistSummary.copyAll');
	}
	return t(
		'components.domains.dnsChecklistSummary.copyOutstanding',
		{ count: copyTargets.value.length },
		copyTargets.value.length
	);
});

const handleCopy = () =>
	copy(
		toZoneFileLines(copyTargets.value, props.domain, {
			valueOverrides: props.valueOverrides,
			notes: props.notes,
		}),
		'zone-file'
	);

const percent = computed(() =>
	summary.value.total === 0 ? 0 : Math.round((summary.value.verified / summary.value.total) * 100)
);

const jumpTo = (entry: ChecklistEntry) => {
	const el = document.getElementById(props.anchorFor(entry));
	if (!el) return;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
	// Move focus with the view so keyboard and screen-reader users land there too.
	el.focus({ preventScroll: true });
};
</script>

<template>
	<div
		v-if="summary.total > 0"
		class="mb-4 rounded-xl border border-border-subtle bg-bg-surface p-4"
		data-testid="dns-checklist-summary"
	>
		<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div class="min-w-0 flex-1">
				<p
					:class="[
						'text-sm font-medium',
						summary.allVerified ? 'text-success' : 'text-text-primary',
					]"
					data-testid="dns-checklist-headline"
				>
					<template v-if="summary.allVerified">
						{{ t('components.domains.dnsChecklistSummary.allFound', { total: summary.total }) }}
					</template>
					<template v-else-if="summary.checked">
						{{
							t('components.domains.dnsChecklistSummary.progress', {
								verified: summary.verified,
								total: summary.total,
							})
						}}
					</template>
					<template v-else>
						{{
							t(
								'components.domains.dnsChecklistSummary.unchecked',
								{ total: summary.total },
								summary.total
							)
						}}
					</template>
				</p>
				<div
					v-if="summary.checked"
					class="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-deep"
					role="progressbar"
					:aria-valuenow="summary.verified"
					aria-valuemin="0"
					:aria-valuemax="summary.total"
					:aria-label="t('components.domains.dnsChecklistSummary.progressLabel')"
				>
					<div
						:class="['h-full rounded-full', summary.allVerified ? 'bg-success' : 'bg-brand']"
						:style="{ width: `${percent}%` }"
					/>
				</div>
			</div>
			<UiButton
				variant="secondary"
				class="gap-1.5 text-sm py-1.5 px-3 shrink-0 self-start"
				:title="t('components.domains.dnsChecklistSummary.copyTitle')"
				data-testid="dns-copy-zone"
				@click="handleCopy"
			>
				<Icon
					:name="isCopied('zone-file') ? 'lucide:check' : 'lucide:clipboard-copy'"
					:class="['w-4 h-4', isCopied('zone-file') && 'text-success']"
				/>
				{{ isCopied('zone-file') ? t('common.copied') : copyLabel }}
			</UiButton>
		</div>

		<!-- One link per record still to do, named as the row is. -->
		<div
			v-if="summary.checked && summary.outstanding.length > 0"
			class="mt-3 flex flex-wrap items-center gap-1.5"
			data-testid="dns-outstanding"
		>
			<span class="text-xs text-text-secondary mr-1">
				{{ t('components.domains.dnsChecklistSummary.stillMissing') }}
			</span>
			<button
				v-for="entry in summary.outstanding"
				:key="entry.id"
				type="button"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-error/30 bg-error/10 text-error text-xs font-medium hover:bg-error/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('components.domains.dnsChecklistSummary.jumpTo', { label: entry.label })"
				data-testid="dns-outstanding-link"
				@click="jumpTo(entry)"
			>
				<Icon name="lucide:x-circle" class="w-3 h-3" />
				{{ entry.label }}
			</button>
		</div>
	</div>
</template>
