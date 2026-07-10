<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail } from '~/utils/validation';
import { mapSenderVerification } from '~/utils/campaignSenderVerification';

useHead({ title: 'Campaign senders — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Curating the campaign-sender list is an admin surface (backend floor:
// settings:manage). Editors can build and send campaigns FROM this list but do
// not decide what is on it, so this page stays owner/admin-only even though d4
// opened the campaign pipeline to editors. Gate the whole page on the same
// owner/admin floor the backend enforces, and avoid flashing the gate before
// the role resolves.
const { showAdminGate } = usePermissions();
const { hasActiveOrganization } = useOrganizationContext();

const {
	data: senders,
	isLoading: sendersLoading,
	error: sendersError,
} = useOrganizationQuery(api.campaigns.senders.list);

const { data: settings } = useOrganizationQuery(api.organizations.settings.get);

// --- "Allow custom from-addresses" toggle -----------------------------------
// Local mirror of the instance setting so the switch feels instant; the query
// re-emits the authoritative value on save.
const allowCustom = ref(false);
watch(
	settings,
	(value) => {
		allowCustom.value = value?.isCustomCampaignSendersAllowed === true;
	},
	{ immediate: true }
);

// The switch flips instantly (optimistic apply) and rolls back only if the
// write fails — the shared helper owns the categorized failure toast.
const { run: saveAllowCustom, isLoading: savingSettings } = useOptimisticMutation(
	api.organizations.settings.update,
	{ label: 'Update campaign sender policy' }
);

async function onToggleAllowCustom(value: boolean) {
	await saveAllowCustom(
		{ isCustomCampaignSendersAllowed: value },
		{
			apply: () => {
				const previous = allowCustom.value;
				allowCustom.value = value;
				return () => {
					allowCustom.value = previous;
				};
			},
		}
	);
}

// --- Per-sender enable / default / remove -----------------------------------
type SenderRow = NonNullable<typeof senders.value>[number];

const { run: toggleSenderEnabled } = useOptimisticMutation(api.campaigns.senders.update, {
	label: 'Update campaign sender',
});
const { run: setDefaultSender } = useBackendOperation(api.campaigns.senders.setDefault, {
	label: 'Set default campaign sender',
});
const { run: removeSender } = useBackendOperation(api.campaigns.senders.remove, {
	label: 'Remove campaign sender',
});

// Local optimistic overrides for the per-sender enable switch, keyed by id, so
// the toggle feels DONE on click instead of waiting a round-trip. The live query
// re-emits the authoritative value; an override is pruned once the server agrees.
const enabledOverrides = ref<Record<Id<'campaignSenders'>, boolean>>({});

function isSenderEnabled(sender: SenderRow): boolean {
	return enabledOverrides.value[sender._id] ?? sender.isEnabled;
}

watch(senders, (list) => {
	if (!list || Object.keys(enabledOverrides.value).length === 0) return;
	const next: Record<Id<'campaignSenders'>, boolean> = {};
	for (const [id, value] of Object.entries(enabledOverrides.value)) {
		const senderId = id as Id<'campaignSenders'>;
		const server = list.find((s) => s._id === senderId);
		// Keep the override only while the server has not yet caught up to it.
		if (server && server.isEnabled !== value) next[senderId] = value;
	}
	enabledOverrides.value = next;
});

async function onToggleEnabled(sender: SenderRow, value: boolean) {
	const id = sender._id;
	await toggleSenderEnabled(
		{ id, isEnabled: value },
		{
			apply: () => {
				const previous = enabledOverrides.value[id];
				enabledOverrides.value = { ...enabledOverrides.value, [id]: value };
				return () => {
					// Supersede-aware revert: only roll back if OUR optimistic value is
					// still the current override. If a newer toggle for the same sender
					// has since applied a different value, that newer intent wins and
					// this failed write's revert must not clobber it.
					if (enabledOverrides.value[id] !== value) return;
					const next = { ...enabledOverrides.value };
					if (previous === undefined) delete next[id];
					else next[id] = previous;
					enabledOverrides.value = next;
				};
			},
		}
	);
}

// Removal is destructive (and dropping the default leaves no default), so it goes
// through a confirmation dialog — matching the API-key revoke precedent.
const senderPendingRemoval = ref<SenderRow | null>(null);
const isRemoving = ref(false);

function requestRemove(sender: SenderRow) {
	senderPendingRemoval.value = sender;
}

async function confirmRemove() {
	const sender = senderPendingRemoval.value;
	if (!sender) return;
	isRemoving.value = true;
	const result = await removeSender({ id: sender._id });
	isRemoving.value = false;
	if (result !== undefined) {
		senderPendingRemoval.value = null;
	}
}

// --- Add-sender modal --------------------------------------------------------
const isAddOpen = ref(false);
const addForm = reactive({ email: '', displayName: '' });
const addError = ref<string | null>(null);

const { run: createSender, isLoading: creating } = useBackendOperation(
	api.campaigns.senders.create,
	{ label: 'Add campaign sender', inlineTarget: addError }
);

function openAdd() {
	addForm.email = '';
	addForm.displayName = '';
	addError.value = null;
	isAddOpen.value = true;
}

const hasValidEmail = computed(() => isValidEmail(addForm.email.trim()));

const { data: domainStatus, error: domainStatusError } = useOrganizationQuery(
	api.domains.domains.getEmailDomainVerificationStatus,
	() => {
		const email = addForm.email.trim();
		if (!email || !isValidEmail(email)) return undefined;
		return { email };
	}
);

const verification = computed(() =>
	mapSenderVerification(domainStatus.value, hasValidEmail.value, domainStatusError.value !== null)
);

async function onSubmitAdd() {
	addError.value = null;
	if (!verification.value.canAdd) return;
	const result = await createSender({
		email: addForm.email.trim(),
		displayName: addForm.displayName.trim() || undefined,
	});
	if (result !== undefined) {
		isAddOpen.value = false;
	}
}
</script>

<template>
	<div class="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
		<!-- Header -->
		<div>
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary transition-colors mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<h1 class="text-2xl font-semibold text-text-primary">Campaign senders</h1>
			<p class="mt-1 text-text-secondary">
				The from-addresses your team can choose when sending a campaign.
			</p>
		</div>

		<!-- Admins-only gate -->
		<div
			v-if="showAdminGate"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Admins only</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Campaign senders can be managed by organization owners and admins.
			</p>
		</div>

		<!-- No organization -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:mail" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No organization selected</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create or select an organization to manage campaign senders.
			</p>
		</div>

		<!-- Loading -->
		<div v-else-if="sendersLoading && !senders" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading campaign senders…</p>
			</div>
		</div>

		<!-- Error -->
		<UiErrorAlert
			v-else-if="sendersError"
			message="Could not load campaign senders. Please try again."
		/>

		<template v-else>
			<!-- Sender list -->
			<UiCard padding="none" overflow="hidden">
				<template #header>
					<div class="flex items-center justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold text-text-primary">Approved senders</h2>
							<p class="text-xs text-text-tertiary mt-0.5">
								Only enabled addresses can be picked as a campaign's from-address.
							</p>
						</div>
						<UiButton size="sm" @click="openAdd">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							Add sender
						</UiButton>
					</div>
				</template>

				<!-- Empty state -->
				<div
					v-if="(senders?.length ?? 0) === 0"
					class="flex flex-col items-center justify-center py-14 text-center px-6"
				>
					<UiIconBox
						icon="lucide:at-sign"
						size="lg"
						variant="surface"
						rounded="full"
						class="mb-3"
					/>
					<p class="text-text-secondary font-medium">No senders yet</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						Add an address on one of your verified sending domains so your team can send campaigns
						from it.
					</p>
					<UiButton size="sm" variant="secondary" class="mt-4" @click="openAdd">
						Add your first sender
					</UiButton>
				</div>

				<!-- Rows -->
				<ul v-else class="divide-y divide-border-subtle">
					<li
						v-for="sender in senders ?? []"
						:key="sender._id"
						class="flex items-center gap-4 px-5 py-4"
					>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<p class="text-sm font-medium text-text-primary truncate">
									{{ sender.displayName || sender.email }}
								</p>
								<span
									v-if="sender.isDefault"
									class="inline-flex items-center gap-1 text-xs text-brand"
									title="Default sender for new campaigns"
								>
									<Icon name="lucide:star" class="w-3.5 h-3.5 fill-current" />
									Default
								</span>
							</div>
							<p v-if="sender.displayName" class="text-xs text-text-tertiary truncate">
								{{ sender.email }}
							</p>
						</div>

						<button
							v-if="!sender.isDefault"
							type="button"
							class="text-xs text-text-tertiary hover:text-brand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded px-1.5 py-1"
							@click="setDefaultSender({ id: sender._id })"
						>
							Make default
						</button>

						<UiSwitch
							:model-value="isSenderEnabled(sender)"
							:label="`Enable ${sender.email}`"
							@update:model-value="(v) => onToggleEnabled(sender, v)"
						/>

						<button
							type="button"
							class="text-text-tertiary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error rounded p-1"
							:aria-label="`Remove ${sender.email}`"
							@click="requestRemove(sender)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</li>
				</ul>
			</UiCard>

			<!-- Custom senders policy -->
			<UiCard padding="none" overflow="hidden">
				<div class="flex items-start justify-between gap-4 p-5">
					<div>
						<p class="text-sm font-medium text-text-primary">Allow custom from-addresses</p>
						<p class="text-xs text-text-tertiary mt-1 max-w-md">
							Anyone creating a campaign can type any address on a verified domain.
						</p>
					</div>
					<UiSwitch
						:model-value="allowCustom"
						:disabled="savingSettings"
						label="Allow custom from-addresses"
						@update:model-value="onToggleAllowCustom"
					/>
				</div>
			</UiCard>

			<p class="text-xs text-text-tertiary">
				Looking for the address the app itself sends from (verifications, password resets)? That's
				the
				<NuxtLink to="/dashboard/settings" class="text-brand hover:underline">
					default sender in General settings</NuxtLink
				>.
			</p>
		</template>

		<!-- Add-sender modal -->
		<UiModal
			:open="isAddOpen"
			title="Add campaign sender"
			size="md"
			:closable="!creating"
			:persistent="creating"
			@update:open="
				(v) => {
					if (!v) isAddOpen = false;
				}
			"
		>
			<form id="add-sender-form" class="space-y-4" @submit.prevent="onSubmitAdd">
				<UiErrorAlert v-if="addError" :message="addError" />

				<div>
					<UiInput
						v-model="addForm.email"
						type="email"
						label="From email"
						placeholder="e.g., hello@acme.com"
						:disabled="creating"
						required
					/>
					<p
						v-if="verification.tone === 'warning'"
						class="mt-1.5 text-xs text-warning flex items-start gap-1.5"
					>
						<Icon name="lucide:alert-triangle" class="w-3.5 h-3.5 shrink-0 mt-px" />
						<span>
							{{ verification.message }}
							<NuxtLink
								v-if="verification.showDomainsLink"
								to="/dashboard/delivery/domains"
								class="underline hover:text-warning/80 whitespace-nowrap"
							>
								Set up a verified domain →
							</NuxtLink>
						</span>
					</p>
					<p
						v-else-if="verification.tone === 'success'"
						class="mt-1.5 text-xs text-success flex items-center gap-1.5"
					>
						<Icon name="lucide:check-circle" class="w-3.5 h-3.5 shrink-0" />
						{{ verification.message }}
					</p>
					<p v-else class="mt-1.5 text-xs text-text-tertiary">
						{{ verification.message }}
					</p>
				</div>

				<UiInput
					v-model="addForm.displayName"
					label="Display name"
					placeholder="e.g., Acme Newsletter (optional)"
					:disabled="creating"
					help-text="Shown to recipients as the sender name. Optional."
				/>
			</form>

			<template #footer>
				<UiButton variant="secondary" :disabled="creating" @click="isAddOpen = false">
					Cancel
				</UiButton>
				<UiButton
					type="submit"
					form="add-sender-form"
					:loading="creating"
					:disabled="creating || !verification.canAdd"
				>
					{{ creating ? 'Adding…' : 'Add sender' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Remove-sender confirmation -->
		<UiConfirmationDialog
			:open="senderPendingRemoval !== null"
			variant="danger"
			title="Remove campaign sender"
			:description="
				senderPendingRemoval?.isDefault
					? `Remove &quot;${senderPendingRemoval?.email}&quot;? It's the default sender, so new campaigns will have no default until you pick another.`
					: `Remove &quot;${senderPendingRemoval?.email}&quot;? Your team will no longer be able to send campaigns from it.`
			"
			confirm-text="Remove sender"
			:is-loading="isRemoving"
			@update:open="
				(v) => {
					if (!v) senderPendingRemoval = null;
				}
			"
			@confirm="confirmRemove"
		/>
	</div>
</template>
