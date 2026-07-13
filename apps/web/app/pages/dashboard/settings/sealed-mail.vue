<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * Sealed Mail settings (E5, flag `sealedMail`). The org-level sealing policy
 * (locked decision D2): `auto` seals whenever every recipient can receive sealed
 * mail; `ask` keeps sealing available but never seals automatically; `off` never
 * seals. Owner/admin only — the backend floor is `settings:manage`.
 */
useHead({ title: 'Sealed Mail — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { showAdminGate } = usePermissions();
const { hasActiveOrganization } = useOrganizationContext();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { showToast } = useToast();

const sealedMailEnabled = computed(() => isFeatureEnabled('sealedMail'));

const { data: settings } = useOrganizationQuery(api.workspaces.settings.get);

type SealPolicy = 'auto' | 'ask' | 'off';

// Local mirror so the choice feels instant; the query re-emits the authoritative
// value on save. Unset ⇒ `auto` (the resolution-time default).
const policy = ref<SealPolicy>('auto');
watch(
	settings,
	(value) => {
		const stored = value?.sealPolicy;
		policy.value = stored === 'ask' || stored === 'off' ? stored : 'auto';
	},
	{ immediate: true }
);

const { run: savePolicy, isLoading: saving } = useBackendOperation(api.workspaces.settings.update, {
	label: 'Update sealing policy',
});

const OPTIONS: Array<{ value: SealPolicy; title: string; description: string }> = [
	{
		value: 'auto',
		title: 'Seal automatically',
		description:
			'When everyone you are writing to can receive sealed mail, Owlat encrypts the message before it leaves. Recommended.',
	},
	{
		value: 'ask',
		title: 'Keep available, but never automatic',
		description:
			'Owlat keeps discovering keys and shows when a message could be sealed, but never seals on its own — messages are sent normally. Switch to "Seal automatically" to turn on sealing.',
	},
	{
		value: 'off',
		title: 'Never seal',
		description:
			'All Postbox mail is sent normally, even when a recipient could receive it sealed.',
	},
];

async function choose(value: SealPolicy) {
	if (value === policy.value) return;
	const previous = policy.value;
	policy.value = value;
	const result = await savePolicy({ sealPolicy: value });
	if (result === undefined) policy.value = previous;
}

// ── Recovery kit (E6, locked decision D7). The armored private key + plain-words
// instructions for one address — the only sanctioned private-key egress, and the
// import path to restore access after a rebuild. Owner/admin only.
const kitAddress = ref('');
const importAddress = ref('');
const importKey = ref('');

const { run: exportKit, isLoading: exporting } = useBackendOperation(
	api.e2ee.lifecycleNode.exportRecoveryKit,
	{ label: 'Export recovery kit', type: 'action' }
);
const { run: importKit, isLoading: importing } = useBackendOperation(
	api.e2ee.lifecycleNode.importRecoveryKit,
	{ label: 'Import recovery kit', type: 'action' }
);

async function downloadKit() {
	const address = kitAddress.value.trim();
	if (!address) return;
	const kit = await exportKit({ address });
	if (kit === undefined) return; // operation error already surfaced
	if (kit === null) {
		showToast('No sealed-mail key exists for that address yet.', 'error');
		return;
	}
	// Bundle the instructions and the private key into one downloadable file.
	const contents = `${kit.instructions}\n\n${kit.privateKeyArmored}\n`;
	const blob = new Blob([contents], { type: 'application/pgp-keys' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = kit.filename;
	anchor.click();
	URL.revokeObjectURL(url);
	showToast('Recovery kit downloaded. Store it somewhere private and offline.', 'success');
}

async function restoreKit() {
	const address = importAddress.value.trim();
	const privateKeyArmored = importKey.value.trim();
	if (!address || !privateKeyArmored) return;
	const result = await importKit({ address, privateKeyArmored });
	if (result === undefined) return;
	if (result.imported) {
		showToast(
			'Recovery kit imported. Sealed mail for this address can be opened again.',
			'success'
		);
		importKey.value = '';
	} else {
		showToast("That key doesn't match this address, so it wasn't imported.", 'error');
	}
}
</script>

<template>
	<div class="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
		<div>
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary transition-colors mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<h1 class="text-2xl font-semibold text-text-primary">Sealed Mail</h1>
			<p class="mt-1 text-text-secondary">
				How Owlat encrypts personal mail between you and other Owlat workspaces.
			</p>
		</div>

		<div v-if="showAdminGate" class="rounded border border-border-subtle p-6 text-text-secondary">
			Only owners and admins can change the sealing policy.
		</div>
		<div
			v-else-if="!hasActiveOrganization"
			class="rounded border border-border-subtle p-6 text-text-secondary"
		>
			Select a workspace to manage its sealing policy.
		</div>
		<template v-else>
			<div
				v-if="!sealedMailEnabled"
				class="flex items-start gap-2.5 rounded border border-border-subtle bg-bg-elevated p-4"
			>
				<Icon name="lucide:info" class="w-4 h-4 text-text-tertiary flex-shrink-0 mt-0.5" />
				<p class="text-sm text-text-secondary">
					Sealed Mail is turned off for this workspace, so nothing is sealed yet. You can still
					choose the policy below — it takes effect once Sealed Mail is enabled in Features.
				</p>
			</div>

			<fieldset class="space-y-2.5">
				<legend class="sr-only">Sealing policy</legend>
				<label
					v-for="opt in OPTIONS"
					:key="opt.value"
					class="flex items-start gap-3 rounded border p-4 cursor-pointer transition-colors"
					:class="
						policy === opt.value
							? 'border-brand bg-brand/5'
							: 'border-border-subtle hover:bg-bg-elevated'
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

			<!-- Recovery kit (E6 / D7): download the private key for an address so
			     sealed mail can be restored later; import one to restore access. -->
			<section class="space-y-4 rounded border border-border-subtle p-5">
				<div>
					<h2 class="text-base font-semibold text-text-primary">Recovery kit</h2>
					<p class="mt-1 text-sm text-text-secondary">
						A recovery kit is the private key that opens sealed mail for one address, plus
						plain-language instructions. Download one for each address and keep it somewhere private
						and offline. There is no master copy on the server, so a recovery kit is the only way to
						restore sealed mail if this instance is rebuilt.
					</p>
				</div>

				<div class="space-y-2">
					<label for="kit-address" class="block text-sm font-medium text-text-primary">
						Download a recovery kit
					</label>
					<div class="flex flex-wrap items-center gap-2">
						<input
							id="kit-address"
							v-model="kitAddress"
							type="email"
							inputmode="email"
							autocomplete="off"
							placeholder="you@your-domain.com"
							data-testid="recovery-kit-address"
							class="min-w-0 flex-1 rounded border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						/>
						<UiButton
							variant="secondary"
							size="sm"
							:loading="exporting"
							:disabled="!kitAddress.trim()"
							@click="downloadKit"
						>
							Download recovery kit
						</UiButton>
					</div>
				</div>

				<div class="space-y-2 border-t border-border-subtle pt-4">
					<label for="kit-import-address" class="block text-sm font-medium text-text-primary">
						Restore from a recovery kit
					</label>
					<p class="text-xs text-text-secondary">
						Paste a previously downloaded recovery kit to restore access for its address.
					</p>
					<input
						id="kit-import-address"
						v-model="importAddress"
						type="email"
						inputmode="email"
						autocomplete="off"
						placeholder="you@your-domain.com"
						data-testid="recovery-kit-import-address"
						class="w-full rounded border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					/>
					<textarea
						id="kit-import-key"
						v-model="importKey"
						rows="4"
						spellcheck="false"
						placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
						data-testid="recovery-kit-import-key"
						class="w-full rounded border border-border-subtle bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					/>
					<div class="flex justify-end">
						<UiButton
							variant="secondary"
							size="sm"
							:loading="importing"
							:disabled="!importAddress.trim() || !importKey.trim()"
							@click="restoreKit"
						>
							Import recovery kit
						</UiButton>
					</div>
				</div>
			</section>
		</template>
	</div>
</template>
