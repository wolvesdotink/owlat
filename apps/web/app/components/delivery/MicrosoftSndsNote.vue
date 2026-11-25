<script setup lang="ts">
/**
 * What Microsoft SNDS currently says about the sending addresses, for the
 * Deliverability Center. A red address sends Microsoft mail at a reduced rate
 * (`delivery/sndsStanding.ts`), which the operator has to be able to see; a
 * yellow one is a warning only. Spam-trap hits are their own finding, shown
 * under the address even while its filter result is green: they mean the list
 * holds addresses that never signed up, which list hygiene fixes and waiting
 * does not. Renders nothing without a fresh reading.
 */
import { TriangleWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	standings: readonly { ip: string; filterResult: 'red' | 'yellow'; periodStart: number }[];
	trapHits: readonly { ip: string; trapHits: number; periodStart: number }[];
}>();

const { t, locale } = useI18n();

const K = 'dashboard.admin.delivery.deliverability.microsoftSnds';
const DOCS = 'https://docs.owlat.app/developer/external-reputation-feedback';
const RECOVERY_DOCS = `${DOCS}#when-snds-reports-an-address-red`;
const TRAP_DOCS = `${DOCS}#when-snds-counts-spam-trap-hits`;

const hasRed = computed(() => props.standings.some((standing) => standing.filterResult === 'red'));

// SNDS days are UTC days.
function day(periodStart: number): string {
	return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }).format(
		new Date(periodStart)
	);
}

/** One entry per address, its filter result first and its trap hits under it. */
const addresses = computed(() => {
	const ips = [
		...new Set([...props.standings.map((row) => row.ip), ...props.trapHits.map((row) => row.ip)]),
	].sort((a, b) => a.localeCompare(b));
	return ips.map((ip) => {
		const standing = props.standings.find((row) => row.ip === ip);
		const traps = props.trapHits.find((row) => row.ip === ip);
		return {
			ip,
			lines: [
				...(standing
					? [t(`${K}.${standing.filterResult}`, { ip, day: day(standing.periodStart) })]
					: []),
				...(traps
					? [t(`${K}.trapHits`, { ip, day: day(traps.periodStart), count: traps.trapHits })]
					: []),
			],
		};
	});
});
</script>

<template>
	<div
		v-if="addresses.length > 0"
		role="status"
		class="card p-5"
		:class="hasRed ? 'border-error/30 bg-error/5' : 'border-warning/30 bg-warning/5'"
		data-testid="microsoft-snds-note"
	>
		<div class="flex gap-3">
			<TriangleWarningIcon
				class="w-5 h-5 shrink-0 mt-0.5"
				:class="hasRed ? 'text-error' : 'text-warning'"
				aria-hidden="true"
			/>
			<div class="min-w-0 space-y-1.5">
				<h3 class="font-medium text-text-primary">
					{{ t(`${K}.title`) }}
				</h3>
				<template v-for="address in addresses" :key="address.ip">
					<p
						v-for="(line, index) in address.lines"
						:key="index"
						class="text-sm text-text-secondary"
					>
						{{ line }}
					</p>
				</template>
				<div class="flex flex-wrap gap-x-4 gap-y-1">
					<a
						v-if="hasRed"
						:href="RECOVERY_DOCS"
						target="_blank"
						rel="noopener"
						class="link text-sm font-medium"
					>
						{{ t(`${K}.action`) }}
					</a>
					<a
						v-if="trapHits.length > 0"
						:href="TRAP_DOCS"
						target="_blank"
						rel="noopener"
						class="link text-sm font-medium"
					>
						{{ t(`${K}.trapAction`) }}
					</a>
				</div>
			</div>
		</div>
	</div>
</template>
