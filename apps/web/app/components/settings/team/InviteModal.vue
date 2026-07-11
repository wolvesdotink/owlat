<script setup lang="ts">
import { api } from '@owlat/api';
import type { OrganizationRole } from '~/composables/useOrganization';
import { isValidEmail } from '~/utils/validation';
import { ROLE_DEFINITIONS } from '~/utils/teamRoles';

// Use BetterAuth organization management (shared useState-backed store — the
// same invitations/invite the parent page reads).
const { organizationId, invitations, invite } = useOrganization();

// Roles an admin may invite into (never owner — ownership is transferred, not
// invited). Copy is the single ROLE_DEFINITIONS source so the invite modal and
// the role legend never diverge.
const inviteRoleOptions = ROLE_DEFINITIONS.filter((r) => r.role !== 'owner');

// Copyable accept links, shared with the Team page so the two build and copy
// identical links.
const { buildAcceptUrl, copyLinkText } = useInviteLinks();

// Postbox feature + verified domain lookup for the optional mailbox slot.
const { isEnabled } = useFeatureFlag();
const postboxEnabled = computed(() => isEnabled('postbox'));
const { data: domainsData } = useConvexQuery(api.domains.domains.listByOrganization, () => ({}));
const verifiedDomains = computed(() =>
	(domainsData.value ?? []).filter((d) => d.status === 'verified')
);
// Domains a mailbox may be RESERVED on — verified ones plus those still setting
// up (registering/pending DNS). Reserving on a not-yet-verified domain is how a
// brand-new instance gives its earliest invitees a real "your mailbox is
// reserved, activates when your domain verifies" step instead of a dead end; the
// mailbox only materializes once the domain verifies (backend claim gate).
// Verified domains sort first so the default pick is a live one when available.
const reservableDomains = computed(() =>
	(domainsData.value ?? [])
		.filter((d) => d.status === 'verified' || d.status === 'pending' || d.status === 'registering')
		.sort((a, b) => Number(b.status === 'verified') - Number(a.status === 'verified'))
);
const canOfferMailbox = computed(() => postboxEnabled.value && reservableDomains.value.length > 0);

// Whether an outbound transport is actually configured. The invite API call
// succeeds even when it isn't (the send hook fails closed and BetterAuth
// swallows the error), so we only claim "we emailed them" when a transport
// exists — otherwise the accept link is the real (and only) way in.
const { data: emailConfigured } = useConvexQuery(
	api.workspaces.featureFlags.deliveryConfigured,
	() => ({})
);

// Invite modal state (shared form-modal primitive for the open/close/form/
// submitting state). The two error slots stay in a dedicated reactive because
// `mailbox` is a cross-field error, not a form field.
const {
	isOpen: isInviteModalOpen,
	isSubmitting: isInviting,
	form: inviteForm,
	open: openInviteFormModal,
	reset: resetInviteFormState,
} = useFormModal({
	email: '',
	role: 'editor' as OrganizationRole,
	addMailbox: false,
	mailboxLocalpart: '',
	mailboxDomain: '',
	mailboxDisplayName: '',
});
const inviteFormErrors = reactive({
	email: '',
	mailbox: '',
});

// After a successful invite we keep the modal open on a success panel that
// surfaces the copyable accept link. Cleared when the modal closes and on
// "Invite another".
const inviteSuccess = ref<{
	email: string;
	acceptUrl: string;
	mailboxAddress?: string;
	// The reserved mailbox's domain is still verifying — it activates on verify.
	mailboxAwaitingDomain?: boolean;
} | null>(null);

// Once the admin hand-edits the mailbox local part we stop auto-deriving it
// from the invitee's email address.
const localpartEdited = ref(false);

// True once the admin manually toggles the "Reserve a mailbox" checkbox. Until
// then the form is pristine, so the default-on watcher below may still apply the
// reserved-by-default rule when hosted mail resolves after the modal is open.
const mailboxTouched = ref(false);

// Pre-select the first reservable domain (verified-first) when the user opts into
// the mailbox section.
watch(
	() => [inviteForm.addMailbox, reservableDomains.value.length] as const,
	([addMailbox]) => {
		if (addMailbox && !inviteForm.mailboxDomain && reservableDomains.value.length > 0) {
			inviteForm.mailboxDomain = reservableDomains.value[0]!.domain;
		}
	}
);

const mailboxPreviewAddress = computed(() => {
	const lp = inviteForm.mailboxLocalpart.trim().toLowerCase();
	if (!lp || !inviteForm.mailboxDomain) return '';
	return `${lp}@${inviteForm.mailboxDomain}`;
});

// The chosen mailbox domain is live vs still verifying — drives the honest
// pre-verification copy in the modal (progress, not "ready now").
const selectedDomainVerified = computed(() =>
	verifiedDomains.value.some((d) => d.domain === inviteForm.mailboxDomain)
);

// Suggest a mailbox local part from the invitee's email until the admin edits it.
function deriveLocalpart(email: string): string {
	const local = email.split('@')[0] ?? '';
	return local.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}
watch(
	() => inviteForm.email,
	(email) => {
		if (!localpartEdited.value) {
			inviteForm.mailboxLocalpart = deriveLocalpart(email);
		}
	}
);

function resetInviteForm() {
	resetInviteFormState();
	inviteFormErrors.email = '';
	inviteFormErrors.mailbox = '';
	localpartEdited.value = false;
	mailboxTouched.value = false;
	inviteSuccess.value = null;
}

// Open the invite modal with a fresh form + cleared errors. A personal mailbox
// is reserved by default whenever hosted mail is configured (verified domain +
// Postbox); the admin can uncheck it.
function openInviteModal() {
	openInviteFormModal();
	resetInviteForm();
	inviteForm.addMailbox = canOfferMailbox.value;
}

// Reserved-by-default (locked decision #4): if the modal opens before the
// verified-domains query resolves, `canOfferMailbox` is briefly false and the
// checkbox snapshots unchecked. Re-apply the default the moment hosted mail
// becomes available — but only while the form is still pristine (modal open, not
// on the success panel, checkbox untouched) so we never override a deliberate
// uncheck.
watch(canOfferMailbox, (canOffer) => {
	if (canOffer && isInviteModalOpen.value && !inviteSuccess.value && !mailboxTouched.value) {
		inviteForm.addMailbox = true;
	}
});

// Reset the form whenever the modal is dismissed so the next open starts clean.
watch(isInviteModalOpen, (open) => {
	if (!open) resetInviteForm();
});

// "Invite another" from the success panel: clear the form but keep the modal
// open, re-applying the default mailbox reservation.
function startAnotherInvite() {
	resetInviteForm();
	inviteForm.addMailbox = canOfferMailbox.value;
}

// Toast notification using global composable
const { showToast } = useToast();

const localpartRegex = /^[a-z0-9._-]+$/i;

// Validate invite form
const validateInviteForm = (): boolean => {
	inviteFormErrors.email = '';
	inviteFormErrors.mailbox = '';

	if (!inviteForm.email.trim()) {
		inviteFormErrors.email = 'Email is required';
		return false;
	}

	if (!isValidEmail(inviteForm.email.trim())) {
		inviteFormErrors.email = 'Please enter a valid email address';
		return false;
	}

	// Warn before submit if this address already has a pending invite — resending
	// or copying the existing link is what the admin actually wants here.
	const emailNorm = inviteForm.email.trim().toLowerCase();
	if (invitations.value.some((inv) => inv.email.toLowerCase() === emailNorm)) {
		inviteFormErrors.email =
			'There is already a pending invite for this address. Resend or copy its link from the list below.';
		return false;
	}

	if (inviteForm.addMailbox) {
		const lp = inviteForm.mailboxLocalpart.trim();
		if (!lp) {
			inviteFormErrors.mailbox = 'Local part is required for the mailbox';
			return false;
		}
		if (!localpartRegex.test(lp)) {
			inviteFormErrors.mailbox = 'Use letters, digits, dots, hyphens, or underscores';
			return false;
		}
		if (!inviteForm.mailboxDomain) {
			inviteFormErrors.mailbox = 'Pick a verified domain';
			return false;
		}
	}

	return true;
};

// Handle invite submission
const handleInvite = async () => {
	if (!organizationId.value) return;
	if (!validateInviteForm()) return;

	isInviting.value = true;

	const mailbox = inviteForm.addMailbox
		? {
				localpart: inviteForm.mailboxLocalpart.trim().toLowerCase(),
				domain: inviteForm.mailboxDomain,
				displayName: inviteForm.mailboxDisplayName.trim() || undefined,
			}
		: undefined;
	// Reserving on a domain that's still verifying — the mailbox activates when it
	// verifies rather than at accept time. Snapshot it for the honest copy below.
	const mailboxAwaitingDomain = Boolean(mailbox) && !selectedDomainVerified.value;

	try {
		const { invitationId } = await invite(inviteForm.email.trim(), inviteForm.role, mailbox);

		if (invitationId) {
			// Keep the modal open on the success panel so the admin can copy the
			// accept link — the always-works path when email delivery isn't set up.
			inviteSuccess.value = {
				email: inviteForm.email.trim(),
				acceptUrl: buildAcceptUrl(invitationId),
				mailboxAddress: mailbox ? `${mailbox.localpart}@${mailbox.domain}` : undefined,
				mailboxAwaitingDomain,
			};
		} else {
			let successMsg = `Invitation sent to ${inviteForm.email}`;
			if (mailbox) {
				successMsg = mailboxAwaitingDomain
					? `Invitation sent to ${inviteForm.email}. Mailbox ${mailbox.localpart}@${mailbox.domain} is reserved and activates when ${mailbox.domain} verifies.`
					: `Invitation sent to ${inviteForm.email}. Mailbox ${mailbox.localpart}@${mailbox.domain} will be created when they accept.`;
			}
			showToast(successMsg);
			isInviteModalOpen.value = false;
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Failed to send invitation';
		showToast(errorMessage, 'error');
	} finally {
		isInviting.value = false;
	}
};

// Opened by the parent's "Invite Member" affordances (all permission-gated).
defineExpose({ open: openInviteModal });
</script>

<template>
	<UiModal v-model:open="isInviteModalOpen" title="Invite Team Member">
		<form v-if="!inviteSuccess" @submit.prevent="handleInvite">
			<div class="space-y-4">
				<!-- Email -->
				<UiInput
					v-model="inviteForm.email"
					type="email"
					label="Email Address"
					placeholder="colleague@company.com"
					:error="inviteFormErrors.email"
					:disabled="isInviting"
					:required="true"
				/>

				<!-- Role — copy comes from the single ROLE_DEFINITIONS source so it
				     stays honest to the permission map (owner is never invitable). -->
				<div>
					<label class="label">Role</label>
					<div class="grid grid-cols-2 gap-3">
						<button
							v-for="def in inviteRoleOptions"
							:key="def.role"
							type="button"
							:class="[
								'p-3 rounded-xl border text-left transition-all',
								inviteForm.role === def.role
									? 'border-brand bg-brand/10'
									: 'border-border-subtle hover:border-border-default',
							]"
							:disabled="isInviting"
							@click="inviteForm.role = def.role"
						>
							<div class="flex items-center gap-2 mb-1">
								<Icon :name="def.icon" class="w-4 h-4 text-text-secondary" />
								<span class="font-medium text-text-primary text-sm">{{ def.label }}</span>
							</div>
							<p class="text-xs text-text-secondary">{{ def.summary }}</p>
							<p class="mt-0.5 text-xs text-text-tertiary">{{ def.detail }}</p>
						</button>
					</div>
				</div>

				<!-- Reserve a personal mailbox (Postbox). On by default when hosted
				     mail is configured; shown disabled with an explanation when it
				     isn't, rather than hidden. -->
				<div class="space-y-3 pt-2 border-t border-border-subtle">
					<label
						class="flex items-start gap-2"
						:class="canOfferMailbox ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'"
					>
						<input
							v-model="inviteForm.addMailbox"
							type="checkbox"
							class="mt-0.5"
							:disabled="isInviting || !canOfferMailbox"
							@change="mailboxTouched = true"
						/>
						<span>
							<span class="font-medium text-text-primary text-sm">
								Reserve a personal mailbox for this user
							</span>
							<span v-if="canOfferMailbox" class="block text-xs text-text-secondary mt-0.5">
								We reserve the address now and create the mailbox when they accept. On by default —
								uncheck to invite without one.
							</span>
							<span v-else-if="postboxEnabled" class="block text-xs text-text-secondary mt-0.5">
								Add a sending domain to reserve mailboxes for new members — you can invite them now
								and their mailbox activates when the domain verifies.
								<NuxtLink to="/dashboard/delivery/domains" class="text-brand hover:underline">
									Add a domain
								</NuxtLink>
							</span>
							<span v-else class="block text-xs text-text-secondary mt-0.5">
								Set up hosted mail — a sending domain and the Postbox — to reserve mailboxes for new
								members.
							</span>
						</span>
					</label>

					<div v-if="canOfferMailbox && inviteForm.addMailbox" class="space-y-3 pl-6">
						<div>
							<label class="text-sm font-medium block mb-1">Address</label>
							<div class="flex items-center gap-2">
								<input
									v-model="inviteForm.mailboxLocalpart"
									type="text"
									placeholder="marcel"
									class="input flex-1"
									:disabled="isInviting"
									pattern="[a-zA-Z0-9.\-_]+"
									@input="localpartEdited = true"
								/>
								<span class="text-text-tertiary">@</span>
								<select v-model="inviteForm.mailboxDomain" class="input" :disabled="isInviting">
									<option value="">Select domain</option>
									<option v-for="d in reservableDomains" :key="d._id" :value="d.domain">
										{{ d.domain }}{{ d.status === 'verified' ? '' : ' (verifying…)' }}
									</option>
								</select>
							</div>
							<p
								v-if="mailboxPreviewAddress && selectedDomainVerified"
								class="text-xs text-text-tertiary mt-1"
							>
								Will be created as: <code>{{ mailboxPreviewAddress }}</code>
							</p>
							<p
								v-else-if="mailboxPreviewAddress"
								class="text-xs text-text-tertiary mt-1"
								data-testid="invite-mailbox-awaiting-domain"
							>
								<code>{{ mailboxPreviewAddress }}</code> is reserved now and activates automatically
								once <span class="font-medium">{{ inviteForm.mailboxDomain }}</span> verifies.
								<NuxtLink to="/dashboard/delivery/domains" class="text-brand hover:underline">
									Finish verifying
								</NuxtLink>
							</p>
						</div>

						<div>
							<label for="inviteform-mailboxdisplayname" class="text-sm font-medium block mb-1">
								Display name (optional)
							</label>
							<input
								id="inviteform-mailboxdisplayname"
								v-model="inviteForm.mailboxDisplayName"
								type="text"
								placeholder="Marcel Pfeifer"
								class="input w-full"
								:disabled="isInviting"
							/>
						</div>

						<p v-if="inviteFormErrors.mailbox" class="text-sm text-error">
							{{ inviteFormErrors.mailbox }}
						</p>
					</div>
				</div>
			</div>
		</form>

		<!-- Success state: surface the copyable accept link. This link works even
		     when outbound email delivery isn't configured yet. -->
		<div v-else class="space-y-4">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:check" size="sm" variant="brand" rounded="lg" />
				<div>
					<p class="font-medium text-text-primary">Invitation ready</p>
					<p v-if="emailConfigured" class="text-sm text-text-secondary">
						We emailed {{ inviteSuccess?.email }} — you can also share the accept link directly.
					</p>
					<p v-else class="text-sm text-text-secondary">
						Share the accept link below with {{ inviteSuccess?.email }} — email delivery isn't set
						up yet, so this is how they get in.
					</p>
				</div>
			</div>

			<p
				v-if="inviteSuccess?.mailboxAddress && inviteSuccess?.mailboxAwaitingDomain"
				class="text-sm text-text-secondary"
			>
				Mailbox <code>{{ inviteSuccess.mailboxAddress }}</code> is reserved — it activates
				automatically once its sending domain verifies.
			</p>
			<p v-else-if="inviteSuccess?.mailboxAddress" class="text-sm text-text-secondary">
				Mailbox <code>{{ inviteSuccess.mailboxAddress }}</code> will be created when they accept.
			</p>

			<div>
				<label class="text-sm font-medium block mb-1">Accept link</label>
				<div class="flex items-center gap-2">
					<input
						:value="inviteSuccess?.acceptUrl"
						readonly
						class="input flex-1 font-mono text-xs"
						@focus="($event.target as HTMLInputElement).select()"
					/>
					<UiButton variant="secondary" @click="copyLinkText(inviteSuccess?.acceptUrl ?? '')">
						<template #iconLeft>
							<Icon name="lucide:copy" class="w-4 h-4" />
						</template>
						Copy
					</UiButton>
				</div>
				<p class="text-xs text-text-tertiary mt-1">
					Works even if email delivery isn't set up yet.
				</p>
			</div>
		</div>

		<template #footer>
			<template v-if="inviteSuccess">
				<UiButton variant="secondary" @click="startAnotherInvite()">
					<template #iconLeft>
						<Icon name="lucide:user-plus" class="w-4 h-4" />
					</template>
					Invite another
				</UiButton>
				<UiButton @click="isInviteModalOpen = false">Done</UiButton>
			</template>
			<template v-else>
				<UiButton variant="secondary" :disabled="isInviting" @click="isInviteModalOpen = false">
					Cancel
				</UiButton>
				<UiButton :loading="isInviting" @click="handleInvite">
					<template #iconLeft>
						<Icon v-if="!isInviting" name="lucide:user-plus" class="w-4 h-4" />
					</template>
					{{ isInviting ? 'Sending...' : 'Send Invitation' }}
				</UiButton>
			</template>
		</template>
	</UiModal>
</template>
