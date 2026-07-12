<script setup lang="ts">
import { api } from '@owlat/api';
import type { MtaStsMode } from '@owlat/shared/mtaStsPolicy';

/**
 * MTA-STS publishing stepper (Delivery → provider config).
 *
 * MTA-STS (RFC 8461) lets senders REQUIRE encrypted, certificate-verified
 * delivery TO this deployment. Publishing it is a deliberate none → testing →
 * enforce progression: `testing` first (senders only report failures, so a
 * mistake can't blackhole inbound mail), then `enforce` once TLS-RPT looks
 * clean. This card writes `instanceSettings.mtaStsMode` (admin-gated on the
 * backend) and points the operator at the DNS records they must publish.
 *
 * Human copy only — the plain-language explanation lives here; the DNS record
 * bytes live on the Domains page (the `_mta-sts` TXT + `mta-sts` records).
 */

const { canManageOrganization } = usePermissions();
const { showToast } = useToast();

const { data: settings, isLoading } = useConvexQuery(api.workspaces.settings.get, {});
// Admin-gated guidance: is a policy actually being served (mail host present)?
const { data: guidance } = useConvexQuery(api.domains.domains.getMtaStsGuidance, {});

const mode = computed<MtaStsMode>(() => settings.value?.mtaStsMode ?? 'none');

const { run: updateSettings, isLoading: isSaving } = useBackendOperation(
	api.workspaces.settings.update,
	{ label: 'Update MTA-STS mode' }
);

// All segments disable together for a non-admin (or while a save is in flight):
// SegmentedControl honours per-option `disabled`, and `selectMode` guards too.
const options = computed(() => {
	const locked = !canManageOrganization.value || isSaving.value;
	return [
		{ value: 'none', label: 'Off', disabled: locked },
		{ value: 'testing', label: 'Testing', disabled: locked },
		{ value: 'enforce', label: 'Enforce', disabled: locked },
	];
});

const DESCRIPTIONS: Record<MtaStsMode, string> = {
	none: 'No policy is published. Senders deliver mail to you exactly as they do today.',
	testing:
		'A policy is published, but senders only report TLS problems — they never fail delivery. The safe first step while you watch for issues.',
	enforce:
		'Senders must deliver over verified TLS or the message is rejected. Turn this on only once testing looks clean.',
};

// Enforce is published but there's no mail host to serve a policy for — the
// policy can't actually take effect, so warn honestly.
const enforceWithoutHost = computed(() => mode.value === 'enforce' && !guidance.value?.mailHost);

async function selectMode(next: string) {
	if (!canManageOrganization.value || next === mode.value) return;
	const res = await updateSettings({ mtaStsMode: next as MtaStsMode });
	if (res === undefined) return; // failure already toasted
	showToast(
		next === 'none'
			? 'MTA-STS turned off — no policy is published.'
			: next === 'testing'
				? 'MTA-STS set to testing — senders will report TLS problems without failing delivery.'
				: 'MTA-STS set to enforce — publish the DNS records so senders require verified TLS.'
	);
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:lock" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Inbound TLS policy (MTA-STS)</h2>
					<p class="text-sm text-text-secondary">
						Let senders require encrypted delivery to your mail server
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-4">
			<!-- Loading -->
			<div v-if="isLoading" class="flex items-center gap-3 py-2">
				<UiSpinner size="sm" />
				<span class="text-sm text-text-secondary">Loading policy…</span>
			</div>

			<template v-else>
				<div role="group" aria-label="MTA-STS mode">
					<UiSegmentedControl
						:options="options"
						:model-value="mode"
						@update:model-value="selectMode"
					/>
				</div>

				<p class="text-sm text-text-secondary">{{ DESCRIPTIONS[mode] }}</p>

				<!-- Once a policy is published, point at the DNS records to add. -->
				<p v-if="mode !== 'none'" class="text-sm text-text-secondary">
					Add the <code class="bg-bg-surface px-1.5 py-0.5 rounded text-xs">_mta-sts</code> and
					<code class="bg-bg-surface px-1.5 py-0.5 rounded text-xs">mta-sts</code> DNS records on
					the
					<NuxtLink to="/dashboard/delivery/domains" class="text-brand hover:underline"
						>Domains page</NuxtLink
					>
					so senders can find and trust this policy.
				</p>

				<!-- Honest warning: enforce with no mail host can't take effect. -->
				<p v-if="enforceWithoutHost" class="text-sm text-warning">
					No inbound mail host is configured, so an enforced policy can't be served yet. Set up
					receiving first, or switch back to testing.
				</p>

				<p v-if="!canManageOrganization" class="text-xs text-text-tertiary">
					Only owners and admins can change this.
				</p>
			</template>
		</div>
	</UiCard>
</template>
