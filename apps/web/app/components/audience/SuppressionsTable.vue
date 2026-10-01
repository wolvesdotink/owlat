<script setup lang="ts">
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { type BlockReason, suppressionReasonPresentation } from '~/utils/suppressionReasons';
import {
	indexSuppressionProvenance,
	suppressionProvenanceLine,
} from '~/utils/suppressionProvenance';
import { useLocalized } from '~/composables/useLocalized';

/**
 * The suppression list itself: one row per blocked address, with the reason
 * badge, the notes/provenance column and the remove action. Split out of
 * pages/dashboard/audience/suppressions.vue so the page stays a controller
 * (filters, counts, modals) and the row rendering — including the "who put this
 * here?" lookup that only the notes column needs — lives with the markup.
 */

/** One blocklist row, exactly as `blockedEmails.listByTeam` returns it. */
type SuppressionRow = FunctionReturnType<typeof api.blockedEmails.listByTeam>[number];

defineProps<{ rows: SuppressionRow[] }>();

const emit = defineEmits<{ remove: [row: SuppressionRow] }>();

const { t } = useI18n();
const localized = useLocalized();

// WHO PUT THIS HERE. A `manual` row can be a colleague's decision or a provider
// blacklist hit mirrored in with nobody behind it; the audit entry is
// what tells them apart. Admin-gated, so it simply stays empty for a member and
// the column falls back to saying nothing.
const { data: provenanceData } = useOrganizationQuery(api.blockedEmails.listProviderProvenance);
const provenanceById = computed(() => indexSuppressionProvenance(provenanceData.value));
// `suppressionProvenanceLine` picks the message and its parameters (the provider
// name is part of the key, the evidence code a param) but never resolves them —
// the sentence is assembled here, where a locale exists.
const provenanceFor = (blockedEmailId: string): string | null => {
	const line = suppressionProvenanceLine(provenanceById.value.get(blockedEmailId));
	return line === null ? null : localized(line);
};

// The reason -> badge/icon/label decision lives in ONE place (see
// `~/utils/suppressionReasons`), shared with the contact-profile notice. The
// parameter is the closed `BlockReason` union, so the lookup is total: a fifth
// schema literal fails the build instead of silently rendering as "manual".
const presentation = (reason: BlockReason) => suppressionReasonPresentation(reason);
</script>

<template>
	<table class="w-full">
		<thead>
			<tr class="border-b border-border-subtle bg-bg-surface/50">
				<th
					class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 sm:px-6 py-3"
				>
					{{ t('dashboard.audience.suppressions.table.email') }}
				</th>
				<th
					class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3 hidden sm:table-cell"
				>
					{{ t('dashboard.audience.suppressions.table.reason') }}
				</th>
				<th
					class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3 hidden md:table-cell"
				>
					{{ t('dashboard.audience.suppressions.table.notes') }}
				</th>
				<th
					class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3 hidden lg:table-cell"
				>
					{{ t('dashboard.audience.suppressions.table.dateAdded') }}
				</th>
				<th
					class="text-right text-xs font-medium text-text-tertiary uppercase tracking-wider px-4 sm:px-6 py-3"
				>
					<span class="max-sm:sr-only">{{ t('common.actions') }}</span>
				</th>
			</tr>
		</thead>
		<tbody class="divide-y divide-border-subtle">
			<tr
				v-for="blockedEmail in rows"
				:key="blockedEmail._id"
				class="hover:bg-bg-surface/30 transition-colors"
			>
				<td class="px-4 sm:px-6 py-4">
					<div class="flex items-center gap-3">
						<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center shrink-0">
							<Icon
								:name="presentation(blockedEmail.reason).icon"
								class="w-4 h-4 text-text-secondary"
							/>
						</div>
						<div class="min-w-0">
							<span class="block text-sm font-medium text-text-primary break-all sm:break-normal">
								{{ blockedEmail.email }}
							</span>
							<!-- Below sm the Reason column is hidden (the email and the remove
							     button need the width), so the badge rides under the address. -->
							<span
								:class="[
									'sm:hidden mt-1 inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium border',
									presentation(blockedEmail.reason).badge,
								]"
							>
								{{ t(presentation(blockedEmail.reason).label) }}
							</span>
						</div>
					</div>
				</td>
				<td class="px-6 py-4 hidden sm:table-cell">
					<span
						:class="[
							'inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium border',
							presentation(blockedEmail.reason).badge,
						]"
					>
						{{ t(presentation(blockedEmail.reason).label) }}
					</span>
				</td>
				<td class="px-6 py-4 hidden md:table-cell">
					<span
						v-if="blockedEmail.notes"
						class="text-sm text-text-secondary truncate max-w-[200px] 2xl:max-w-sm block"
						:title="blockedEmail.notes"
					>
						{{ blockedEmail.notes }}
					</span>
					<span
						v-else-if="provenanceFor(blockedEmail._id)"
						class="text-sm text-text-secondary block"
						data-testid="suppression-provenance"
					>
						{{ provenanceFor(blockedEmail._id) }}
					</span>
					<span v-else class="text-sm text-text-tertiary">—</span>
				</td>
				<td class="px-6 py-4 hidden lg:table-cell">
					<span class="text-sm text-text-secondary">
						{{ formatDateTime(blockedEmail.createdAt) }}
					</span>
				</td>
				<td class="px-4 sm:px-6 py-4 text-right">
					<UiButton
						variant="ghost"
						class="p-2 text-error hover:bg-error/10"
						:title="t('dashboard.audience.suppressions.removeSuppression')"
						:aria-label="t('dashboard.audience.suppressions.removeSuppression')"
						@click="emit('remove', blockedEmail)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</UiButton>
				</td>
			</tr>
		</tbody>
	</table>
</template>
