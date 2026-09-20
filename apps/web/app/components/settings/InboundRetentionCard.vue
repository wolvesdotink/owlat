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
 * loses a conversation — and neither does it touch personal-mailbox (Postbox)
 * mail, which keeps its own files permanently.
 *
 * There is deliberately no "keep forever": unbounded growth on a route any
 * sender can reach is the problem the window exists to solve.
 *
 * RETENTION IS NOT THE SAME SWITCH AS READING. Whether the assistant reads an
 * attachment at all depends on attachment scanning being enabled on the MTA
 * (`scan.attachments` / the `clamav` compose profile) — without it nothing
 * inbound is indexed, however long the window is. The card says so, because an
 * operator who set a 365-day window and still sees "not scanned for malware" on
 * every message has no other way to find out why.
 */

const { t } = useI18n();
const { canManageOrganization } = usePermissions();
const { showToast } = useToast();

const { data: settings, isLoading } = useConvexQuery(api.workspaces.settings.get, {});

const selected = computed<InboundRawRetentionDays>(
	() => settings.value?.inboundRawRetentionDays ?? DEFAULT_INBOUND_RAW_RETENTION_DAYS
);

const options = computed(() =>
	INBOUND_RAW_RETENTION_DAY_CHOICES.map((days) => ({
		value: days,
		label: t('components.settings.inboundRetentionCard.dayOption', { count: days }),
	}))
);

const { run: updateSettings } = useBackendOperation(api.workspaces.settings.update, {
	label: () => t('components.settings.inboundRetentionCard.updateOperation'),
});

/**
 * `UiSelect` is generic over `string | number` and hands back the option's own
 * value, so the number the Convex validator demands arrives as a number — a
 * raw `<select>`'s `event.target.value` is always a string, and the closed
 * day-count validator rejects a string.
 */
async function onSelect(next: InboundRawRetentionDays | null) {
	if (!canManageOrganization.value || next === null) return;
	if (next === selected.value) return;
	const res = await updateSettings({ inboundRawRetentionDays: next });
	if (!res.ok) return; // failure already toasted
	showToast(t('components.settings.inboundRetentionCard.savedToast'));
}
</script>

<template>
	<!-- The UI layer's card primitive, like the neighbouring MigrationModeCard —
	     a settings card is not the place to re-decide what a card looks like. -->
	<UiCard>
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:archive" size="sm" variant="surface" rounded="lg" />
				<div class="min-w-0">
					<h2 class="text-lg font-medium text-text-primary">
						{{ t('components.settings.inboundRetentionCard.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.settings.inboundRetentionCard.description') }}
					</p>
				</div>
			</div>
		</template>

		<div class="flex items-start justify-between gap-4">
			<p v-if="!canManageOrganization" class="text-xs text-text-tertiary">
				{{ t('components.settings.inboundRetentionCard.adminOnly') }}
			</p>
			<span v-else />
			<UiSpinner v-if="isLoading" size="sm" />
			<div v-else class="w-44 flex-shrink-0" data-testid="inbound-retention-days">
				<UiSelect
					:model-value="selected"
					:options="options"
					:label="t('components.settings.inboundRetentionCard.label')"
					:disabled="!canManageOrganization"
					size="sm"
					@update:model-value="onSelect"
				/>
			</div>
		</div>

		<!-- The other half of the feature, and the one an operator cannot infer
		     from this card: retention decides how long files are KEPT, attachment
		     scanning decides whether the assistant ever reads them. -->
		<p class="mt-4 text-xs text-text-tertiary" data-testid="inbound-retention-scan-note">
			{{ t('components.settings.inboundRetentionCard.scanNote') }}
		</p>
	</UiCard>
</template>
