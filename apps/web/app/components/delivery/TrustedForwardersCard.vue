<script setup lang="ts">
import { api } from '@owlat/api';
import { DEFAULT_TRUSTED_ARC_FORWARDERS, isValidForwarderDomain } from '@owlat/shared/arcTrust';
import { normalizeDomain } from '@owlat/shared';
import { useSettingsForm } from '~/composables/useSettingsForm';

/**
 * Trusted forwarders editor (Delivery → provider config), Sealed Mail A5.
 *
 * A mailing list or forwarding account re-sends mail from its own servers, which
 * breaks the author's DKIM signature and makes DMARC fail — so a legitimate
 * forwarded message would land in Spam. When a forwarder on THIS list has
 * cryptographically vouched (a valid ARC chain) that the original really did
 * pass, we keep the message in the inbox and mark it "verified via forwarder"
 * instead of failing it.
 *
 * The card writes `instanceSettings.trustedArcForwarders` (admin-gated on the
 * backend). An empty list turns the rescue OFF entirely; leaving it at the
 * seeded defaults is the safe starting point. Human copy only — no ARC/DMARC
 * jargon beyond naming the mechanism plainly.
 */

const { t } = useI18n();
const { canManageOrganization } = usePermissions();
const { showToast } = useToast();

const {
	data: settings,
	isLoading,
	error: settingsError,
	refetch: refetchSettings,
} = useConvexQuery(api.workspaces.settings.get, {});

const { run: updateSettings } = useBackendOperation(api.workspaces.settings.update, {
	label: () => t('components.delivery.trustedForwardersCard.operationLabel'),
});

// The draft of the list. The settings query returns the whole instance settings
// row, so it re-emits whenever any field on it is written (the TLS and MTA-STS
// cards on this page save on change); the form follows those emissions only
// while nothing here is unsaved. Until the read answers it holds the seeded
// defaults, and `loaded` keeps Save off so they can never be written over a
// stored list nobody saw. No leave guard: this is one card on a long page.
const {
	form,
	loaded,
	isDirty: dirty,
	isSaving,
	handleSave,
	resetToDefaults: restoreDefaults,
} = useSettingsForm({
	source: settings,
	defaults: { forwarders: [...DEFAULT_TRUSTED_ARC_FORWARDERS] },
	// The operator's saved list, or the seeded defaults when they have never
	// touched it (unset). An explicit empty array is respected (the rescue is
	// off) — distinct from "never set".
	project: (row) => ({
		forwarders:
			row?.trustedArcForwarders != null
				? [...row.trustedArcForwarders]
				: [...DEFAULT_TRUSTED_ARC_FORWARDERS],
	}),
	save: async ({ forwarders }) => {
		const res = await updateSettings({ trustedArcForwarders: forwarders });
		if (!res.ok) return false; // failure already toasted
		showToast(
			forwarders.length === 0
				? t('components.delivery.trustedForwardersCard.clearedToast')
				: t('components.delivery.trustedForwardersCard.savedToast')
		);
		return true;
	},
	leaveGuard: false,
});

const newDomain = ref('');

function addDomain() {
	if (!canManageOrganization.value) return;
	const domain = normalizeDomain(newDomain.value);
	// A bare, dot-bearing domain only — reject blanks, spaces, and single labels
	// so a typo can't silently widen who we trust. Same rule the backend enforces.
	if (!isValidForwarderDomain(domain)) return;
	if (form.forwarders.includes(domain)) {
		newDomain.value = '';
		return;
	}
	form.forwarders = [...form.forwarders, domain];
	newDomain.value = '';
}

function removeDomain(domain: string) {
	if (!canManageOrganization.value) return;
	form.forwarders = form.forwarders.filter((d) => d !== domain);
}

function resetToDefaults() {
	if (!canManageOrganization.value) return;
	restoreDefaults();
}

async function save() {
	if (!canManageOrganization.value || !dirty.value) return;
	await handleSave();
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:forward" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('components.delivery.trustedForwardersCard.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.delivery.trustedForwardersCard.subtitle') }}
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-4">
			<div v-if="isLoading" class="flex items-center gap-3 py-2">
				<UiSpinner size="sm" />
				<span class="text-sm text-text-secondary">
					{{ t('components.delivery.trustedForwardersCard.loading') }}
				</span>
			</div>

			<UiQueryBoundary v-else-if="settingsError" :error="settingsError" @retry="refetchSettings" />

			<template v-else>
				<p class="text-sm text-text-secondary max-w-prose">
					{{ t('components.delivery.trustedForwardersCard.explainer') }}
				</p>

				<!-- Current list -->
				<ul
					v-if="form.forwarders.length"
					class="flex flex-wrap gap-2"
					data-testid="trusted-forwarders-list"
				>
					<li
						v-for="domain in form.forwarders"
						:key="domain"
						class="inline-flex items-center gap-1.5 rounded border border-border-subtle px-2 py-1 text-sm text-text-secondary"
					>
						<span>{{ domain }}</span>
						<button
							v-if="canManageOrganization"
							type="button"
							class="text-text-tertiary hover:text-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand rounded"
							:aria-label="t('components.delivery.trustedForwardersCard.removeDomain', { domain })"
							@click="removeDomain(domain)"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</li>
				</ul>
				<p v-else class="text-sm text-warning">
					{{ t('components.delivery.trustedForwardersCard.emptyState') }}
				</p>

				<!-- Add -->
				<form
					v-if="canManageOrganization"
					class="flex items-center gap-2"
					@submit.prevent="addDomain"
				>
					<UiInput
						v-model="newDomain"
						:placeholder="t('components.delivery.trustedForwardersCard.addPlaceholder')"
						:aria-label="t('components.delivery.trustedForwardersCard.addLabel')"
						class="max-w-xs"
					/>
					<UiButton type="submit" variant="secondary" :disabled="!newDomain.trim()">
						{{ t('common.add') }}
					</UiButton>
				</form>

				<div v-if="canManageOrganization" class="flex items-center gap-2 pt-1">
					<UiButton :disabled="!dirty || isSaving || !loaded" :loading="isSaving" @click="save">
						{{ t('common.save') }}
					</UiButton>
					<UiButton variant="ghost" :disabled="isSaving" @click="resetToDefaults">
						{{ t('components.delivery.trustedForwardersCard.resetToDefaults') }}
					</UiButton>
				</div>

				<p v-else class="text-xs text-text-tertiary">
					{{ t('components.delivery.trustedForwardersCard.adminsOnly') }}
				</p>
			</template>
		</div>
	</UiCard>
</template>
