<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { GENERIC_IMAP_PROVIDER } from '~/utils/mailAutodiscover';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.addAccount.pageTitle') });

definePageMeta({
	layout: 'preferences',
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

const createMailbox = useBackendOperation(api.mail.mailbox.identity.create, {
	label: () => t('dashboard.preferences.addAccount.createMailboxOperation'),
	inlineTarget: error,
});
const createTeamInbox = useBackendOperation(api.mail.mailboxMembers.createShared, {
	label: () => t('dashboard.preferences.addAccount.createTeamInboxOperation'),
	inlineTarget: error,
});

async function handleSubmit() {
	if (!selectedAddress.value) {
		error.value = t('dashboard.preferences.addAccount.errorNoAddress');
		return;
	}
	provisioning.value = true;
	let created: BackendOperationResult<Id<'mailboxes'>>;
	if (isTeam.value) {
		created = await createTeamInbox.run({
			address: selectedAddress.value,
			displayName: displayName.value || undefined,
			memberUserIds: selectedMemberIds.value,
		});
	} else {
		if (!user.value?.id) {
			provisioning.value = false;
			error.value = t('dashboard.preferences.addAccount.errorNotSignedIn');
			return;
		}
		created = await createMailbox.run({
			userId: user.value.id,
			address: selectedAddress.value,
			displayName: displayName.value || undefined,
		});
	}
	provisioning.value = false;
	if (!created.ok) return;
	createdMailboxId.value = created.result;
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
	<div>
		<!-- Step 1: choose address -->
		<section v-if="step === 1" class="card p-6">
			<!-- Personal vs team inbox. Only admins can create a shared team inbox. -->
			<div v-if="isAdmin" class="flex gap-1 p-1 mb-5 rounded-md bg-bg-surface w-fit">
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="mode === 'personal' ? 'bg-bg-base shadow-sm font-medium' : 'text-text-secondary'"
					@click="mode = 'personal'"
				>
					{{ t('dashboard.preferences.addAccount.modePersonal') }}
				</button>
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="mode === 'team' ? 'bg-bg-base shadow-sm font-medium' : 'text-text-secondary'"
					@click="mode = 'team'"
				>
					{{ t('dashboard.preferences.addAccount.modeTeam') }}
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
					{{ t('dashboard.preferences.addAccount.transportHosted') }}
				</button>
				<button
					type="button"
					class="px-3 py-1.5 text-sm rounded transition-colors"
					:class="
						teamTransport === 'external'
							? 'bg-bg-base shadow-sm font-medium'
							: 'text-text-secondary'
					"
					@click="teamTransport = 'external'"
				>
					{{ t('dashboard.preferences.addAccount.transportExternal') }}
				</button>
			</div>

			<h2 class="font-semibold mb-1">
				{{
					isExternalTeam
						? t('dashboard.preferences.addAccount.externalTeamTitle')
						: isTeam
							? t('dashboard.preferences.addAccount.teamTitle')
							: t('dashboard.preferences.addAccount.personalTitle')
				}}
			</h2>
			<I18nT
				v-if="isExternalTeam"
				keypath="dashboard.preferences.addAccount.externalTeamDescription"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary mb-4"
			>
				<template #example><code>support@yourcompany.com</code></template>
			</I18nT>
			<I18nT
				v-else-if="isTeam"
				keypath="dashboard.preferences.addAccount.teamDescription"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary mb-4"
			>
				<template #support><code>support@</code></template>
				<template #sales><code>sales@</code></template>
			</I18nT>

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
						{{ t('dashboard.preferences.addAccount.displayNameLabel') }}
					</label>
					<input
						id="ext-team-displayname"
						v-model="displayName"
						type="text"
						:placeholder="t('dashboard.preferences.addAccount.displayNamePlaceholderTeam')"
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

			<UiQueryBoundary v-else :loading="domainsLoading && !domainsData" :error="domainsError">
				<template #loading>
					<div class="flex items-center gap-2 text-text-secondary text-sm py-4">
						<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none" />
						{{ t('dashboard.preferences.addAccount.checkingDomains') }}
					</div>
				</template>
				<div v-if="verifiedDomains.length === 0" class="text-text-secondary text-sm">
					{{ t('dashboard.preferences.addAccount.needVerifiedDomain') }}
					<NuxtLink to="/dashboard/admin/delivery/domains" class="text-brand hover:underline">
						{{ t('dashboard.preferences.addAccount.verifyDomainFirst') }}
					</NuxtLink>
					<div v-if="isEnabled('mail.external')" class="mt-4 pt-4 border-t border-border-subtle">
						<p class="mb-2">{{ t('dashboard.preferences.addAccount.noDomainHint') }}</p>
						<UiButton variant="secondary" size="sm" to="/dashboard/postbox/migrate">
							<Icon name="lucide:mail-plus" class="w-4 h-4 mr-1.5" />
							{{ t('dashboard.preferences.addAccount.connectExternalMailbox') }}
						</UiButton>
					</div>
				</div>
				<div v-else class="space-y-4">
					<div>
						<label class="text-sm font-medium block mb-1">{{
							t('dashboard.preferences.addAccount.addressLabel')
						}}</label>
						<div class="flex items-center gap-2">
							<input
								v-model="localPart"
								type="text"
								:placeholder="
									isTeam
										? t('dashboard.preferences.addAccount.addressPlaceholderTeam')
										: t('dashboard.preferences.addAccount.addressPlaceholderPersonal')
								"
								class="input flex-1"
								pattern="[a-zA-Z0-9.\-_]+"
							/>
							<span class="text-text-tertiary">@</span>
							<select v-model="selectedDomain" class="input">
								<option value="">{{ t('dashboard.preferences.addAccount.selectDomain') }}</option>
								<option v-for="d in verifiedDomains" :key="d._id" :value="d.domain">
									{{ d.domain }}
								</option>
							</select>
						</div>
						<I18nT
							v-if="selectedAddress"
							keypath="dashboard.preferences.addAccount.willBeCreatedAs"
							tag="p"
							scope="global"
							class="text-xs text-text-tertiary mt-1"
						>
							<template #address
								><code>{{ selectedAddress }}</code></template
							>
						</I18nT>
					</div>

					<div>
						<label for="displayname" class="text-sm font-medium block mb-1">
							{{ t('dashboard.preferences.addAccount.displayNameLabel') }}
						</label>
						<input
							id="displayname"
							v-model="displayName"
							type="text"
							:placeholder="
								isTeam
									? t('dashboard.preferences.addAccount.displayNamePlaceholderTeam')
									: t('dashboard.preferences.addAccount.displayNamePlaceholderPersonal')
							"
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

					<UiButton
						type="button"
						:disabled="!selectedAddress || provisioning"
						@click="handleSubmit"
					>
						<Icon v-if="provisioning" name="lucide:loader-2" class="w-4 h-4 mr-1.5 animate-spin motion-reduce:animate-none" />
						{{
							provisioning
								? t('dashboard.preferences.addAccount.creating')
								: isTeam
									? t('dashboard.preferences.addAccount.createTeamInbox')
									: t('dashboard.preferences.addAccount.createMailbox')
						}}
					</UiButton>
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
				{{
					isExternalTeam
						? t('dashboard.preferences.addAccount.successTeamTitle')
						: t('dashboard.preferences.addAccount.successTitle', { address: selectedAddress })
				}}
			</h2>
			<p class="text-text-secondary mt-2">
				{{
					isTeam
						? t('dashboard.preferences.addAccount.successTeamBody')
						: t('dashboard.preferences.addAccount.successBody')
				}}
				<template v-if="isExternalTeam">
					{{ t('dashboard.preferences.addAccount.successExternalNote') }}
				</template>
				<template v-else>
					{{ t('dashboard.preferences.addAccount.successHostedNote') }}
				</template>
			</p>
			<div class="mt-6 flex items-center justify-center gap-3">
				<UiButton
					v-if="isTeam && createdMailboxId"
					:to="`/dashboard/preferences/members/${createdMailboxId}`"
				>
					{{ t('dashboard.preferences.addAccount.manageMembers') }}
				</UiButton>
				<UiButton v-else to="/dashboard/postbox/inbox">{{
					t('dashboard.preferences.addAccount.openInbox')
				}}</UiButton>
				<!-- Stays a button, not the shared PreferencesBackLink: this is the
				     secondary half of a two-button row, and a text link beside a
				     primary button reads as a footnote rather than the other choice.
				     Only the stale "settings" wording is corrected. -->
				<UiButton variant="ghost" to="/dashboard/preferences">
					{{ t('dashboard.preferences.addAccount.backToPreferences') }}
				</UiButton>
			</div>
		</section>
	</div>
</template>
