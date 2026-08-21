<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * Sealed Mail settings (E5, flag `sealedMail`). The org-level sealing policy
 * (locked decision D2): `auto` seals whenever every recipient can receive sealed
 * mail; `ask` keeps sealing available but never seals automatically; `off` never
 * seals. Owner/admin only — the backend floor is `settings:manage`, and the
 * `admin` route middleware below redirects a non-admin to /dashboard before this
 * page renders, so the page itself never has to say "owners and admins only".
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.sealedMail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

const { hasActiveOrganization } = useOrganizationContext();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { showToast } = useToast();

const sealedMailEnabled = computed(() => isFeatureEnabled('sealedMail'));

const { data: settings } = useOrganizationQuery(api.workspaces.settings.get);

type SealPolicy = 'auto' | 'ask' | 'off';

// Local mirror so the choice feels instant; the query re-emits the authoritative
// value on save. Unset ⇒ `auto` (the resolution-time default).
const policy = ref<SealPolicy>('auto');
const isInboundTlsRequired = ref(true);
watch(
	settings,
	(value) => {
		const stored = value?.sealPolicy;
		policy.value = stored === 'ask' || stored === 'off' ? stored : 'auto';
		isInboundTlsRequired.value = value?.isInboundTlsRequired !== false;
	},
	{ immediate: true }
);

const { run: saveSettings, isLoading: saving } = useBackendOperation(
	api.workspaces.settings.update,
	{
		label: () => t('dashboard.admin.instance.sealedMail.updateOperation'),
	}
);

const OPTIONS = computed<Array<{ value: SealPolicy; title: string; description: string }>>(() => [
	{
		value: 'auto',
		title: t('dashboard.admin.instance.sealedMail.options.auto.title'),
		description: t('dashboard.admin.instance.sealedMail.options.auto.description'),
	},
	{
		value: 'ask',
		title: t('dashboard.admin.instance.sealedMail.options.ask.title'),
		description: t('dashboard.admin.instance.sealedMail.options.ask.description'),
	},
	{
		value: 'off',
		title: t('dashboard.admin.instance.sealedMail.options.off.title'),
		description: t('dashboard.admin.instance.sealedMail.options.off.description'),
	},
]);

async function choose(value: SealPolicy) {
	if (value === policy.value) return;
	const previous = policy.value;
	policy.value = value;
	const result = await saveSettings({ sealPolicy: value });
	if (result === undefined) policy.value = previous;
}

async function setInboundTlsRequired(value: boolean) {
	if (value === isInboundTlsRequired.value) return;
	const previous = isInboundTlsRequired.value;
	isInboundTlsRequired.value = value;
	const result = await saveSettings({ isInboundTlsRequired: value });
	if (result === undefined) isInboundTlsRequired.value = previous;
}

// ── Recovery kit (E6, locked decision D7). The armored private key + plain-words
// instructions for one address — the only sanctioned private-key egress, and the
// import path to restore access after a rebuild. Owner/admin only.
const kitAddress = ref('');
const importAddress = ref('');
const importKey = ref('');

const { run: exportKit, isLoading: exporting } = useBackendOperation(
	api.e2ee.lifecycleNode.exportRecoveryKit,
	{ label: () => t('dashboard.admin.instance.sealedMail.exportKitOperation'), type: 'action' }
);
const { run: importKit, isLoading: importing } = useBackendOperation(
	api.e2ee.lifecycleNode.importRecoveryKit,
	{ label: () => t('dashboard.admin.instance.sealedMail.importKitOperation'), type: 'action' }
);

async function downloadKit() {
	const address = kitAddress.value.trim();
	if (!address) return;
	const kit = await exportKit({ address });
	if (kit === undefined) return; // operation error already surfaced
	if (kit === null) {
		showToast(t('dashboard.admin.instance.sealedMail.toasts.noKeyForAddress'), 'error');
		return;
	}
	// Bundle the instructions and the private key into one downloadable file.
	const contents = `${kit.instructions}\n\n${kit.privateKeyArmored}\n`;
	const blob = new Blob([contents], { type: 'application/pgp-keys' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = kit.filename;
	// Attach to the DOM before clicking — some browsers won't trigger a download
	// from a detached anchor (matches the `downloadCsv` convention).
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
	showToast(t('dashboard.admin.instance.sealedMail.toasts.kitDownloaded'), 'success');
}

async function restoreKit() {
	const address = importAddress.value.trim();
	const privateKeyArmored = importKey.value.trim();
	if (!address || !privateKeyArmored) return;
	const result = await importKit({ address, privateKeyArmored });
	if (result === undefined) return;
	if (result.imported) {
		showToast(t('dashboard.admin.instance.sealedMail.toasts.kitImported'), 'success');
		importKey.value = '';
	} else {
		showToast(t('dashboard.admin.instance.sealedMail.toasts.kitMismatch'), 'error');
	}
}

// ── Re-seal after an instance-secret change (E6). After rotating INSTANCE_SECRET
// (with the previous value kept in INSTANCE_SECRET_PREVIOUS during the window),
// this re-encrypts every stored key under the new secret so the old secret can be
// retired. The reachable operator trigger the self-host docs point at. Admin only.
const { run: reSeal, isLoading: reSealing } = useBackendOperation(api.e2ee.lifecycle.reSealVault, {
	label: () => t('dashboard.admin.instance.sealedMail.reSealOperation'),
});

async function runReSeal() {
	const result = await reSeal({});
	if (result === undefined) return;
	showToast(t('dashboard.admin.instance.sealedMail.toasts.reSealStarted'), 'success');
}
</script>

<template>
	<div class="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
		<div>
			<NuxtLink
				to="/dashboard/admin"
				class="inline-flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary transition-colors mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.instance.sealedMail.backToSettings') }}
			</NuxtLink>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.instance.sealedMail.title') }}
			</h1>
			<p class="mt-1 text-text-secondary">
				{{ t('dashboard.admin.instance.sealedMail.intro') }}
			</p>
		</div>

		<div v-if="!hasActiveOrganization" class="card text-text-secondary">
			{{ t('dashboard.admin.instance.sealedMail.noWorkspace') }}
		</div>
		<template v-else>
			<div
				v-if="!sealedMailEnabled"
				class="flex items-start gap-2.5 card p-4"
			>
				<Icon name="lucide:info" class="w-4 h-4 text-text-tertiary flex-shrink-0 mt-0.5" />
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.instance.sealedMail.disabledNotice') }}
				</p>
			</div>

			<fieldset class="space-y-2.5">
				<legend class="sr-only">{{ t('dashboard.admin.instance.sealedMail.policyLegend') }}</legend>
				<label
					v-for="opt in OPTIONS"
					:key="opt.value"
					class="flex items-start gap-3 rounded-(--radius-card) border p-4 cursor-pointer transition-colors"
					:class="
						policy === opt.value
							? 'border-brand bg-brand/5'
							: 'border-transparent shadow-surface-1 hover:bg-bg-elevated'
					"
				>
					<input
						type="radio"
						name="seal-policy"
						class="mt-1 accent-brand"
						:value="opt.value"
						:checked="policy === opt.value"
						:disabled="saving"
						:data-testid="`seal-policy-${opt.value}`"
						@change="choose(opt.value)"
					/>
					<span class="min-w-0">
						<span class="block text-sm font-medium text-text-primary">{{ opt.title }}</span>
						<span class="mt-0.5 block text-xs text-text-secondary">{{ opt.description }}</span>
					</span>
				</label>
			</fieldset>

			<section class="space-y-4 card p-5">
				<div class="flex items-start justify-between gap-4">
					<div class="min-w-0">
						<h2 class="text-base font-semibold text-text-primary">{{ t('dashboard.admin.instance.sealedMail.tls.title') }}</h2>
						<p class="mt-1 text-sm text-text-secondary">
							{{ t('dashboard.admin.instance.sealedMail.tls.description') }}
						</p>
						<p v-if="!isInboundTlsRequired" class="mt-2 text-xs text-warning">
							{{ t('dashboard.admin.instance.sealedMail.tls.plaintextWarning') }}
						</p>
					</div>
					<UiToggle
						:model-value="isInboundTlsRequired"
						:disabled="saving"
						:label="isInboundTlsRequired ? t('common.required') : t('common.optional')"
						data-testid="inbound-tls-required"
						@update:model-value="setInboundTlsRequired"
					/>
				</div>
			</section>

			<!-- Recovery kit (E6 / D7): download the private key for an address so
			     sealed mail can be restored later; import one to restore access. -->
			<section class="space-y-4 card p-5">
				<div>
					<h2 class="text-base font-semibold text-text-primary">
						{{ t('dashboard.admin.instance.sealedMail.recoveryKit.title') }}
					</h2>
					<p class="mt-1 text-sm text-text-secondary">
						{{ t('dashboard.admin.instance.sealedMail.recoveryKit.description') }}
					</p>
				</div>

				<div class="space-y-2">
					<label for="kit-address" class="block text-sm font-medium text-text-primary">
						{{ t('dashboard.admin.instance.sealedMail.recoveryKit.downloadLabel') }}
					</label>
					<div class="flex flex-wrap items-center gap-2">
						<input
							id="kit-address"
							v-model="kitAddress"
							type="email"
							inputmode="email"
							autocomplete="off"
							:placeholder="t('dashboard.admin.instance.sealedMail.recoveryKit.addressPlaceholder')"
							data-testid="recovery-kit-address"
							class="input input-sm min-w-0 flex-1"
						/>
						<UiButton
							variant="secondary"
							size="sm"
							:loading="exporting"
							:disabled="!kitAddress.trim()"
							@click="downloadKit"
						>
							{{ t('dashboard.admin.instance.sealedMail.recoveryKit.downloadButton') }}
						</UiButton>
					</div>
				</div>

				<div class="space-y-2 border-t border-border-subtle pt-4">
					<label for="kit-import-address" class="block text-sm font-medium text-text-primary">
						{{ t('dashboard.admin.instance.sealedMail.recoveryKit.restoreLabel') }}
					</label>
					<p class="text-xs text-text-secondary">
						{{ t('dashboard.admin.instance.sealedMail.recoveryKit.restoreDescription') }}
					</p>
					<input
						id="kit-import-address"
						v-model="importAddress"
						type="email"
						inputmode="email"
						autocomplete="off"
						:placeholder="t('dashboard.admin.instance.sealedMail.recoveryKit.addressPlaceholder')"
						data-testid="recovery-kit-import-address"
						class="input input-sm"
					/>
					<textarea
						id="kit-import-key"
						v-model="importKey"
						rows="4"
						spellcheck="false"
						:placeholder="t('dashboard.admin.instance.sealedMail.recoveryKit.importKeyPlaceholder')"
						data-testid="recovery-kit-import-key"
						class="input input-sm font-mono text-xs"
					/>
					<div class="flex justify-end">
						<UiButton
							variant="secondary"
							size="sm"
							:loading="importing"
							:disabled="!importAddress.trim() || !importKey.trim()"
							@click="restoreKit"
						>
							{{ t('dashboard.admin.instance.sealedMail.recoveryKit.importButton') }}
						</UiButton>
					</div>
				</div>
			</section>

			<!-- Re-seal after an instance-secret change (E6). The reachable trigger the
			     self-host docs point at for the INSTANCE_SECRET rotation acceptance. -->
			<section class="space-y-4 card p-5">
				<div>
					<h2 class="text-base font-semibold text-text-primary">
						{{ t('dashboard.admin.instance.sealedMail.reSeal.title') }}
					</h2>
					<p class="mt-1 text-sm text-text-secondary">
						{{ t('dashboard.admin.instance.sealedMail.reSeal.description') }}
					</p>
				</div>
				<div class="flex justify-end">
					<UiButton
						variant="secondary"
						size="sm"
						:loading="reSealing"
						data-testid="reseal-vault"
						@click="runReSeal"
					>
						{{ t('dashboard.admin.instance.sealedMail.reSeal.button') }}
					</UiButton>
				</div>
			</section>
		</template>
	</div>
</template>
