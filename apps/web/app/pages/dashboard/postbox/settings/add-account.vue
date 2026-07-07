<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Add mail account — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const step = ref<1 | 4>(1);
const localPart = ref('');
const selectedDomain = ref('');
const displayName = ref('');
const provisioning = ref(false);
const error = ref<string | null>(null);
const createdMailboxId = ref<string | null>(null);

// Pull verified domains from existing domains query
const {
	data: domainsData,
	isLoading: domainsLoading,
	error: domainsError,
} = useConvexQuery(api.domains.domains.listVerified, () => ({}));
const verifiedDomains = computed(() => domainsData.value ?? []);
const { isEnabled } = useFeatureFlag();

const selectedAddress = computed(() =>
	localPart.value && selectedDomain.value
		? `${localPart.value.toLowerCase().trim()}@${selectedDomain.value}`
		: ''
);

const createMailbox = useBackendOperation(api.mail.mailbox.create, {
	label: 'Create mailbox',
	inlineTarget: error,
});
const { user } = useAuth();

async function handleSubmit() {
	if (!selectedAddress.value || !user.value?.id) {
		error.value = 'Please select an address and ensure you are signed in';
		return;
	}
	provisioning.value = true;
	const id = await createMailbox.run({
		userId: user.value.id,
		address: selectedAddress.value,
		displayName: displayName.value || undefined,
	});
	provisioning.value = false;
	if (id === undefined) return;
	createdMailboxId.value = id as string;
	step.value = 4;
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-2xl mx-auto">
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<h1 class="text-2xl font-semibold">Add mail account</h1>

		<!-- Step 1: choose address -->
		<section v-if="step === 1" class="card mt-6 p-6">
			<h2 class="font-semibold mb-4">Choose your email address</h2>
			<UiQueryBoundary :loading="domainsLoading && !domainsData" :error="domainsError">
				<template #loading>
					<div class="flex items-center gap-2 text-text-secondary text-sm py-4">
						<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin" />
						Checking your verified domains…
					</div>
				</template>
				<div v-if="verifiedDomains.length === 0" class="text-text-secondary text-sm">
					You need at least one verified domain before creating a hosted mailbox.
					<NuxtLink to="/dashboard/delivery/domains" class="text-brand hover:underline">
						Verify a domain first
					</NuxtLink>
					<div v-if="isEnabled('mail.external')" class="mt-4 pt-4 border-t border-border-subtle">
						<p class="mb-2">No domain to verify? Connect your existing email account instead.</p>
						<NuxtLink
							to="/dashboard/postbox/settings/external-account"
							class="btn btn-secondary btn-sm"
						>
							<Icon name="lucide:mail-plus" class="w-4 h-4 mr-1.5" />
							Connect external mailbox
						</NuxtLink>
					</div>
				</div>
				<div v-else class="space-y-4">
					<div>
						<label class="text-sm font-medium block mb-1">Address</label>
						<div class="flex items-center gap-2">
							<input
								v-model="localPart"
								type="text"
								placeholder="marcel"
								class="input flex-1"
								pattern="[a-zA-Z0-9.\-_]+"
							/>
							<span class="text-text-tertiary">@</span>
							<select v-model="selectedDomain" class="input">
								<option value="">Select domain</option>
								<option v-for="d in verifiedDomains" :key="d._id" :value="d.domain">
									{{ d.domain }}
								</option>
							</select>
						</div>
						<p v-if="selectedAddress" class="text-xs text-text-tertiary mt-1">
							Will be created as: <code>{{ selectedAddress }}</code>
						</p>
					</div>

					<div>
						<label for="displayname" class="text-sm font-medium block mb-1"
							>Display name (optional)</label
						>
						<input
							id="displayname"
							v-model="displayName"
							type="text"
							placeholder="Marcel Pfeifer"
							class="input w-full"
						/>
					</div>

					<div v-if="error" class="text-sm text-error">{{ error }}</div>

					<button
						type="button"
						class="btn btn-primary"
						:disabled="!selectedAddress || provisioning"
						@click="handleSubmit"
					>
						<Icon v-if="provisioning" name="lucide:loader-2" class="w-4 h-4 mr-1.5 animate-spin" />
						{{ provisioning ? 'Creating…' : 'Create mailbox' }}
					</button>
				</div>
			</UiQueryBoundary>
		</section>

		<!-- Step 4: success -->
		<section v-if="step === 4" class="card mt-6 p-6 text-center">
			<div
				class="w-12 h-12 mx-auto rounded-full bg-success-subtle flex items-center justify-center"
			>
				<Icon name="lucide:check" class="w-6 h-6 text-success" />
			</div>
			<h2 class="font-semibold mt-4">{{ selectedAddress }} is ready</h2>
			<p class="text-text-secondary mt-2">
				Your mailbox is connected. Make sure your domain's MX records point to this Owlat instance
				so mail starts flowing.
			</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<NuxtLink to="/dashboard/postbox/inbox" class="btn btn-primary"> Open inbox </NuxtLink>
				<NuxtLink to="/dashboard/postbox/settings" class="btn btn-ghost">
					Back to settings
				</NuxtLink>
			</div>
		</section>
	</div>
</template>
