<script setup lang="ts">
import { api } from '@owlat/api';
import type { OrganizationRole } from '~/composables/useOrganization';
import { isValidEmail } from '@owlat/shared';
import { ROLE_DEFINITIONS } from '~/utils/teamRoles';
import InviteSuccessPanel, {
	type InviteSuccess,
} from '~/components/settings/team/InviteSuccessPanel.vue';

// Use BetterAuth organization management (shared useState-backed store — the
// same invitations/invite the parent page reads).
const { t } = useI18n();

const { organizationId, invitations, invite } = useOrganization();

// Roles an admin may invite into (never owner — ownership is transferred, not
// invited). Copy is the single ROLE_DEFINITIONS source so the invite modal and
// the role legend never diverge.
const inviteRoleOptions = ROLE_DEFINITIONS.filter((r) => r.role !== 'owner');

// Copyable accept links, shared with the Team page so the two build and copy
// identical links (the success panel does the copying).
const { buildAcceptUrl } = useInviteLinks();

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
const inviteSuccess = ref<InviteSuccess | null>(null);

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
		inviteFormErrors.email = t('components.settings.team.inviteModal.emailRequired');
		return false;
	}

	if (!isValidEmail(inviteForm.email.trim())) {
		inviteFormErrors.email = t('components.settings.team.inviteModal.emailInvalid');
		return false;
	}

	// Warn before submit if this address already has a pending invite — resending
	// or copying the existing link is what the admin actually wants here.
	const emailNorm = inviteForm.email.trim().toLowerCase();
	if (invitations.value.some((inv) => inv.email.toLowerCase() === emailNorm)) {
		inviteFormErrors.email = t('components.settings.team.inviteModal.emailAlreadyInvited');
		return false;
	}

	if (inviteForm.addMailbox) {
		const lp = inviteForm.mailboxLocalpart.trim();
		if (!lp) {
			inviteFormErrors.mailbox = t('components.settings.team.inviteModal.mailboxLocalpartRequired');
			return false;
		}
		if (!localpartRegex.test(lp)) {
			inviteFormErrors.mailbox = t('components.settings.team.inviteModal.mailboxLocalpartInvalid');
			return false;
		}
		if (!inviteForm.mailboxDomain) {
			inviteFormErrors.mailbox = t('components.settings.team.inviteModal.mailboxDomainRequired');
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
			let successMsg = t('components.settings.team.inviteModal.invitationSent', {
				email: inviteForm.email,
			});
			if (mailbox) {
				const address = `${mailbox.localpart}@${mailbox.domain}`;
				successMsg = mailboxAwaitingDomain
					? t('components.settings.team.inviteModal.invitationSentMailboxReserved', {
							email: inviteForm.email,
							address,
							domain: mailbox.domain,
						})
					: t('components.settings.team.inviteModal.invitationSentMailboxPending', {
							email: inviteForm.email,
							address,
						});
			}
			showToast(successMsg);
			isInviteModalOpen.value = false;
		}
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: t('components.settings.team.inviteModal.inviteFailed');
		showToast(errorMessage, 'error');
	} finally {
		isInviting.value = false;
	}
};

// Opened by the parent's "Invite Member" affordances (all permission-gated).
defineExpose({ open: openInviteModal });
</script>

<template>
	<UiModal
		v-model:open="isInviteModalOpen"
		:title="t('components.settings.team.inviteModal.title')"
	>
		<form v-if="!inviteSuccess" @submit.prevent="handleInvite">
			<div class="space-y-4">
				<!-- Email -->
				<UiInput
					v-model="inviteForm.email"
					type="email"
					:label="t('components.settings.team.inviteModal.emailLabel')"
					:placeholder="t('components.settings.team.inviteModal.emailPlaceholder')"
					:error="inviteFormErrors.email"
					:disabled="isInviting"
					:required="true"
				/>

				<!-- Role — copy comes from the single ROLE_DEFINITIONS source so it
				     stays honest to the permission map (owner is never invitable). -->
				<div>
					<label class="label">{{ t('components.settings.team.inviteModal.roleLabel') }}</label>
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
								<span class="font-medium text-text-primary text-sm">{{ t(def.label) }}</span>
							</div>
							<p class="text-xs text-text-secondary">{{ t(def.summary) }}</p>
							<p class="mt-0.5 text-xs text-text-tertiary">{{ t(def.detail) }}</p>
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
								{{ t('components.settings.team.inviteModal.reserveMailbox') }}
							</span>
							<span v-if="canOfferMailbox" class="block text-xs text-text-secondary mt-0.5">
								{{ t('components.settings.team.inviteModal.reserveMailboxHint') }}
							</span>
							<span v-else-if="postboxEnabled" class="block text-xs text-text-secondary mt-0.5">
								{{ t('components.settings.team.inviteModal.reserveMailboxNoDomain') }}
								<NuxtLink to="/dashboard/admin/delivery/domains" class="text-brand hover:underline">
									{{ t('components.settings.team.inviteModal.addDomainLink') }}
								</NuxtLink>
							</span>
							<span v-else class="block text-xs text-text-secondary mt-0.5">
								{{ t('components.settings.team.inviteModal.reserveMailboxNoHostedMail') }}
							</span>
						</span>
					</label>

					<div v-if="canOfferMailbox && inviteForm.addMailbox" class="space-y-3 pl-6">
						<div>
							<label class="text-sm font-medium block mb-1">{{
								t('components.settings.team.inviteModal.addressLabel')
							}}</label>
							<div class="flex items-center gap-2">
								<input
									v-model="inviteForm.mailboxLocalpart"
									type="text"
									:placeholder="t('components.settings.team.inviteModal.localpartPlaceholder')"
									class="input flex-1"
									:disabled="isInviting"
									pattern="[a-zA-Z0-9.\-_]+"
									@input="localpartEdited = true"
								/>
								<span class="text-text-tertiary">@</span>
								<select v-model="inviteForm.mailboxDomain" class="input" :disabled="isInviting">
									<option value="">
										{{ t('components.settings.team.inviteModal.selectDomain') }}
									</option>
									<option v-for="d in reservableDomains" :key="d._id" :value="d.domain">
										{{
											d.status === 'verified'
												? d.domain
												: t('components.settings.team.inviteModal.domainVerifying', {
														domain: d.domain,
													})
										}}
									</option>
								</select>
							</div>
							<I18nT
								v-if="mailboxPreviewAddress && selectedDomainVerified"
								keypath="components.settings.team.inviteModal.willBeCreatedAs"
								tag="p"
								scope="global"
								class="text-xs text-text-tertiary mt-1"
							>
								<template #address>
									<code>{{ mailboxPreviewAddress }}</code>
								</template>
							</I18nT>
							<p
								v-else-if="mailboxPreviewAddress"
								class="text-xs text-text-tertiary mt-1"
								data-testid="invite-mailbox-awaiting-domain"
							>
								<I18nT
									keypath="components.settings.team.inviteModal.reservedAwaitingDomain"
									tag="span"
									scope="global"
								>
									<template #address>
										<code>{{ mailboxPreviewAddress }}</code>
									</template>
									<template #domain>
										<span class="font-medium">{{ inviteForm.mailboxDomain }}</span>
									</template>
								</I18nT>
								<NuxtLink to="/dashboard/admin/delivery/domains" class="text-brand hover:underline">
									{{ t('components.settings.team.inviteModal.finishVerifyingLink') }}
								</NuxtLink>
							</p>
						</div>

						<div>
							<label for="inviteform-mailboxdisplayname" class="text-sm font-medium block mb-1">
								{{ t('components.settings.team.inviteModal.displayNameLabel') }}
							</label>
							<input
								id="inviteform-mailboxdisplayname"
								v-model="inviteForm.mailboxDisplayName"
								type="text"
								:placeholder="t('components.settings.team.inviteModal.displayNamePlaceholder')"
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

		<!-- Success state: surface the copyable accept link, which works even when
		     outbound email delivery isn't configured yet. -->
		<InviteSuccessPanel
			v-else-if="inviteSuccess"
			:success="inviteSuccess"
			:email-configured="emailConfigured === true"
		/>

		<template #footer>
			<template v-if="inviteSuccess">
				<UiButton variant="secondary" @click="startAnotherInvite()">
					<template #iconLeft>
						<Icon name="lucide:user-plus" class="w-4 h-4" />
					</template>
					{{ t('components.settings.team.inviteModal.inviteAnother') }}
				</UiButton>
				<UiButton @click="isInviteModalOpen = false">{{ t('common.done') }}</UiButton>
			</template>
			<template v-else>
				<UiButton variant="secondary" :disabled="isInviting" @click="isInviteModalOpen = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="isInviting" @click="handleInvite">
					<template #iconLeft>
						<Icon v-if="!isInviting" name="lucide:user-plus" class="w-4 h-4" />
					</template>
					{{
						isInviting
							? t('components.settings.team.inviteModal.sending')
							: t('components.settings.team.inviteModal.sendInvitation')
					}}
				</UiButton>
			</template>
		</template>
	</UiModal>
</template>
