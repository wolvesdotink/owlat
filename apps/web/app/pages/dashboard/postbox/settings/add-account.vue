<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Add mail account — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const step = ref<1 | 4>(1);
const mode = ref<'personal' | 'team'>('personal');
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
const { isAdmin } = usePermissions();

// Team inbox: only admins may create one, and it needs a member roster from the
// org. Fetched lazily the first time the team mode is selected.
const { members: orgMembers, fetchMembers, isLoadingMembers } = useOrganization();
const selectedMemberIds = ref<string[]>([]);
const isTeam = computed(() => mode.value === 'team');

watch(mode, (value) => {
	if (value === 'team') void fetchMembers();
});

const { user } = useAuth();

// Teammates the creator can add — everyone in the org except themselves (the
// creator is always the team inbox's owner).
const addableMembers = computed(() => orgMembers.value.filter((m) => m.userId !== user.value?.id));

function toggleMember(userId: string) {
	const index = selectedMemberIds.value.indexOf(userId);
	if (index === -1) selectedMemberIds.value.push(userId);
	else selectedMemberIds.value.splice(index, 1);
}

const selectedAddress = computed(() =>
	localPart.value && selectedDomain.value
		? `${localPart.value.toLowerCase().trim()}@${selectedDomain.value}`
		: ''
);

const createMailbox = useBackendOperation(api.mail.mailbox.create, {
	label: 'Create mailbox',
	inlineTarget: error,
});
const createTeamInbox = useBackendOperation(api.mail.mailboxMembers.createShared, {
	label: 'Create team inbox',
	inlineTarget: error,
});

async function handleSubmit() {
	if (!selectedAddress.value) {
		error.value = 'Please choose an address for the mailbox.';
		return;
	}
	provisioning.value = true;
	let id: unknown;
	if (isTeam.value) {
		id = await createTeamInbox.run({
			address: selectedAddress.value,
			displayName: displayName.value || undefined,
			memberUserIds: selectedMemberIds.value,
		});
	} else {
		if (!user.value?.id) {
			provisioning.value = false;
			error.value = 'Please make sure you are signed in.';
			return;
		}
		id = await createMailbox.run({
			userId: user.value.id,
			address: selectedAddress.value,
			displayName: displayName.value || undefined,
		});
	}
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
			<!-- Personal vs team inbox. Only admins can create a shared team inbox. -->
			<div v-if="isAdmin" class="flex gap-1 p-1 mb-5 rounded-md bg-bg-surface w-fit">
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="mode === 'personal' ? 'bg-bg-base shadow-sm font-medium' : 'text-text-secondary'"
					@click="mode = 'personal'"
				>
					Personal mailbox
				</button>
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="mode === 'team' ? 'bg-bg-base shadow-sm font-medium' : 'text-text-secondary'"
					@click="mode = 'team'"
				>
					Team inbox
				</button>
			</div>

			<h2 class="font-semibold mb-1">
				{{ isTeam ? 'Create a team inbox' : 'Choose your email address' }}
			</h2>
			<p v-if="isTeam" class="text-sm text-text-secondary mb-4">
				A shared address your teammates can read and send from together — like
				<code>support@</code> or <code>sales@</code>. You'll be its owner.
			</p>

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
								:placeholder="isTeam ? 'support' : 'marcel'"
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
						<label for="displayname" class="text-sm font-medium block mb-1">
							Display name (optional)
						</label>
						<input
							id="displayname"
							v-model="displayName"
							type="text"
							:placeholder="isTeam ? 'Support' : 'Marcel Pfeifer'"
							class="input w-full"
						/>
					</div>

					<!-- Team inbox: pick the members who can use it. -->
					<div v-if="isTeam">
						<label class="text-sm font-medium block mb-1">Members</label>
						<p class="text-xs text-text-tertiary mb-2">
							Choose who can read and send from this inbox. You can change this later.
						</p>
						<div
							v-if="isLoadingMembers && addableMembers.length === 0"
							class="flex items-center gap-2 text-text-secondary text-sm py-2"
						>
							<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin" />
							Loading teammates…
						</div>
						<p v-else-if="addableMembers.length === 0" class="text-sm text-text-secondary">
							No teammates to add yet — you can invite people and add them later.
						</p>
						<ul v-else class="space-y-1 max-h-56 overflow-y-auto">
							<li v-for="m in addableMembers" :key="m.userId">
								<label
									class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-surface cursor-pointer"
								>
									<input
										type="checkbox"
										:checked="selectedMemberIds.includes(m.userId)"
										@change="toggleMember(m.userId)"
									/>
									<span class="min-w-0">
										<span class="text-sm block truncate">{{ m.user.name || m.user.email }}</span>
										<span class="text-xs text-text-tertiary block truncate">{{
											m.user.email
										}}</span>
									</span>
								</label>
							</li>
						</ul>
					</div>

					<div v-if="error" class="text-sm text-error">{{ error }}</div>

					<button
						type="button"
						class="btn btn-primary"
						:disabled="!selectedAddress || provisioning"
						@click="handleSubmit"
					>
						<Icon v-if="provisioning" name="lucide:loader-2" class="w-4 h-4 mr-1.5 animate-spin" />
						{{ provisioning ? 'Creating…' : isTeam ? 'Create team inbox' : 'Create mailbox' }}
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
				{{
					isTeam
						? 'Your team inbox is ready. Members can open it from their Postbox.'
						: 'Your mailbox is connected.'
				}}
				Make sure your domain's MX records point to this Owlat instance so mail starts flowing.
			</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<NuxtLink
					v-if="isTeam && createdMailboxId"
					:to="`/dashboard/postbox/settings/members/${createdMailboxId}`"
					class="btn btn-primary"
				>
					Manage members
				</NuxtLink>
				<NuxtLink v-else to="/dashboard/postbox/inbox" class="btn btn-primary">
					Open inbox
				</NuxtLink>
				<NuxtLink to="/dashboard/postbox/settings" class="btn btn-ghost">
					Back to settings
				</NuxtLink>
			</div>
		</section>
	</div>
</template>
