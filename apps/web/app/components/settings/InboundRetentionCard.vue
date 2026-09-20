<script setup lang="ts">
import { api } from '@owlat/api';
import {
	DEFAULT_INBOUND_RAW_RETENTION_DAYS,
	INBOUND_RAW_RETENTION_DAY_CHOICES,
	type InboundRawRetentionDays,
} from '@owlat/shared/inboundRetention';

/**
 * How long the shared inbox keeps the FILES belonging to a received message —
 * the original message file and the attachment contents pulled out of it.
 *
 * The card states the trade in those terms rather than as a feature name,
 * because the thing an operator is choosing is storage against the ability to
 * open an attachment later. It also says plainly what is NOT affected: messages,
 * senders and details are kept whatever the window is, so shortening it never
 * loses a conversation.
 *
 * There is deliberately no "keep forever": unbounded growth on a route any
 * sender can reach is the problem the window exists to solve.
 */

const { t } = useI18n();
const { canManageOrganization } = usePermissions();
const { showToast } = useToast();

const { data: settings, isLoading } = useConvexQuery(api.workspaces.settings.get, {});

const selected = computed<InboundRawRetentionDays>(
	() =>
		(settings.value?.inboundRawRetentionDays as InboundRawRetentionDays | undefined) ??
		(DEFAULT_INBOUND_RAW_RETENTION_DAYS as InboundRawRetentionDays)
);

const { run: updateSettings, isLoading: isSaving } = useBackendOperation(
	api.workspaces.settings.update,
	{ label: () => t('components.settings.inboundRetentionCard.updateOperation') }
);

async function onSelect(event: Event) {
	if (!canManageOrganization.value) return;
	const next = Number((event.target as HTMLSelectElement).value) as InboundRawRetentionDays;
	if (next === selected.value) return;
	const res = await updateSettings({ inboundRawRetentionDays: next });
	if (!res.ok) return; // failure already toasted
	showToast(t('components.settings.inboundRetentionCard.savedToast'));
}
</script>

<template>
	<section class="space-y-4 card p-5">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 class="text-base font-semibold text-text-primary">
					{{ t('components.settings.inboundRetentionCard.title') }}
				</h2>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.settings.inboundRetentionCard.description') }}
				</p>
				<p v-if="!canManageOrganization" class="mt-2 text-xs text-text-tertiary">
					{{ t('components.settings.inboundRetentionCard.adminOnly') }}
				</p>
			</div>
			<UiSpinner v-if="isLoading" size="sm" />
			<label v-else class="flex items-center gap-2 text-sm text-text-secondary">
				<span>{{ t('components.settings.inboundRetentionCard.label') }}</span>
				<select
					class="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-sm text-text-primary disabled:opacity-50"
					:value="selected"
					:disabled="!canManageOrganization || isSaving"
					data-testid="inbound-retention-days"
					@change="onSelect"
				>
					<option v-for="days in INBOUND_RAW_RETENTION_DAY_CHOICES" :key="days" :value="days">
						{{ t('components.settings.inboundRetentionCard.dayOption', { count: days }) }}
					</option>
				</select>
			</label>
		</div>
	</section>
</template>
