<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { GENERIC_IMAP_PROVIDER } from '~/utils/mailAutodiscover';

useHead({ title: 'Add mail account — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const step = ref<1 | 4>(1);
// `?mode=team` (the admin Team-inboxes page's create CTA) preselects the team
// tab; anything else starts on personal.
const route = useRoute();
const mode = ref<'personal' | 'team'>(route.query['mode'] === 'team' ? 'team' : 'personal');
const localPart = ref('');
const selectedDomain = ref('');
const displayName = ref('');
const provisioning = ref(false);
const error = ref<string | null>(null);
const createdMailboxId = ref<Id<'mailboxes'> | null>(null);

// Pull verified domains from existing domains query
const {
	data: domainsData,
	isLoading: domainsLoading,
	error: domainsError,
} = useConvexQuery(api.domains.domains.listVerified, () => ({}));
const verifiedDomains = computed(() => domainsData.value ?? []);
const { isEnabled } = useFeatureFlag();
const { isAdmin, showAdminGate } = usePermissions();

// Only admins may create a team inbox (the toggle below is admin-only). If a
// non-admin lands here with `?mode=team`, fall back to personal once the role
// resolves — `showAdminGate` stays false until then, so admins never flicker.
watch(
	showAdminGate,
	(gated) => {
		if (gated && mode.value === 'team') mode.value = 'personal';
	},
	{ immediate: true }
);

// Team inbox: only admins may create one, and it needs a member roster from the
// org. Fetched lazily the first time the team mode is selected.
const { members: orgMembers, fetchMembers, isLoadingMembers } = useOrganization();
const selectedMemberIds = ref<string[]>([]);
const isTeam = computed(() => mode.value === 'team');

// A team inbox can be hosted on a verified domain (the #232 path) OR backed by
// an external IMAP account connected in one motion (#234). The external option
// only appears when the instance has external mailboxes enabled.
const teamTransport = ref<'hosted' | 'external'>('hosted');
const canConnectExternal = computed(() => isEnabled('mail.external'));
const isExternalTeam = computed(() => isTeam.value && teamTransport.value === 'external');

// Immediate so a `?mode=team` deep link loads the roster on first paint too.
watch(
	mode,
	(value) => {
		if (value === 'team') void fetchMembers();
	},
	{ immediate: true }
);

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
	let id: Id<'mailboxes'> | undefined;
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
	createdMailboxId.value = id;
	step.value = 4;
}

// The external team flow submits through the reusable connect form, which
// provisions the shared external mailbox and emits its id back here.
function handleExternalConnected(result?: { mailboxId: string }) {
	if (!result) return;
	createdMailboxId.value = result.mailboxId as Id<'mailboxes'>;
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

			<!-- Team transport: hosted on a verified domain (the #232 path) or an
			     external IMAP account connected as a shared inbox in one motion (#234). -->
			<div
				v-if="isTeam && canConnectExternal"
				class="flex gap-1 p-1 mb-5 rounded-md bg-bg-surface w-fit"
			>
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="
						teamTransport === 'hosted' ? 'bg-bg-base shadow-sm font-medium' : 'text-text-secondary'
					"
					@click="teamTransport = 'hosted'"
				>
					Hosted address
				</button>
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="
						teamTransport === 'external' ? 'bg-bg-base shadow-sm font-medium' : 'text-text-secondary'
					"
					@click="teamTransport = 'external'"
				>
					Connect existing mailbox
				</button>
			</div>

			<h2 class="font-semibold mb-1">
				{{
					isExternalTeam
						? 'Connect a shared mailbox'
						: isTeam
							? 'Create a team inbox'
							: 'Choose your email address'
				}}
			</h2>
			<p v-if="isExternalTeam" class="text-sm text-text-secondary mb-4">
				Connect an existing IMAP mailbox (like <code>support@yourcompany.com</code>) as a shared
				inbox your teammates read and send from together. You'll be its owner, and your team reads
				it through the same connection.
			</p>
			<p v-else-if="isTeam" class="text-sm text-text-secondary mb-4">
				A shared address your teammates can read and send from together — like
				<code>support@</code> or <code>sales@</code>. You'll be its owner.
			</p>

			<!-- External team inbox: pick the roster, then connect the IMAP account.
			     The connect form provisions the shared external mailbox and reports
			     its id back via `@submitted`. -->
			<div v-if="isExternalTeam" class="space-y-5">
				<PostboxTeamMemberPicker
					:members="addableMembers"
					:selected-ids="selectedMemberIds"
					:loading="isLoadingMembers"
					@toggle="toggleMember"
				/>
				<div>
					<label for="ext-team-displayname" class="text-sm font-medium block mb-1">
						Display name (optional)
					</label>
					<input
						id="ext-team-displayname"
						v-model="displayName"
						type="text"
						placeholder="Support"
						class="input w-full"
					/>
				</div>
				<PostboxMailboxConnectForm
					:provider="GENERIC_IMAP_PROVIDER"
					mode="connect"
					shared
					:display-name="displayName || undefined"
					:member-user-ids="selectedMemberIds"
					hide-cancel
					@submitted="handleExternalConnected"
				/>
			</div>

			<UiQueryBoundary
				v-else
				:loading="domainsLoading && !domainsData"
				:error="domainsError"
			>
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
						<NuxtLink to="/dashboard/postbox/migrate" class="btn btn-secondary btn-sm">
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
					<PostboxTeamMemberPicker
						v-if="isTeam"
						:members="addableMembers"
						:selected-ids="selectedMemberIds"
						:loading="isLoadingMembers"
						@toggle="toggleMember"
					/>

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
			<h2 class="font-semibold mt-4">
				{{ isExternalTeam ? 'Your team inbox is connected' : `${selectedAddress} is ready` }}
			</h2>
			<p class="text-text-secondary mt-2">
				{{
					isTeam
						? 'Your team inbox is ready. Members can open it from their Postbox.'
						: 'Your mailbox is connected.'
				}}
				<template v-if="isExternalTeam">
					New mail sent to this address will start appearing here shortly. Mail already in the
					account isn't imported — only messages that arrive from now on.
				</template>
				<template v-else>
					Make sure your domain's MX records point to this Owlat instance so mail starts flowing.
				</template>
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
