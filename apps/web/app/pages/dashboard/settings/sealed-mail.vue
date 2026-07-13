<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * Sealed Mail settings (E5, flag `sealedMail`). The org-level sealing policy
 * (locked decision D2): `auto` seals whenever every recipient can receive sealed
 * mail; `ask` keeps it available but off by default per message; `off` never
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
		title: 'Ask each time',
		description:
			'Sealing stays available, but you choose per message whether to turn it on. Nothing is sealed unless you say so.',
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
		</template>
	</div>
</template>
