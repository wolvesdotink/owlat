<script setup lang="ts">
import { api } from '@owlat/api';
import { acceptInvitation, getSession } from '~/lib/auth-client';

const { t } = useI18n();

useHead({ title: () => t('invite.accept.pageTitle') });

definePageMeta({
	// No layout - standalone page

});

const route = useRoute();
const router = useRouter();

// Get invitation ID from query params
const invitationId = computed(() => (route.query['id'] as string) || '');

// State
const status = ref<'loading' | 'accepting' | 'success' | 'error' | 'login-required'>('loading');
const errorMessage = ref('');
const organizationName = ref('');
const claimedMailboxAddress = ref('');
// An early-instance reservation whose sending domain hasn't verified yet: the
// mailbox is held for them and activates automatically once the domain verifies.
const reservedAwaitingAddress = ref('');
const claimedInboxAddresses = ref<string[]>([]);

const { run: claimPendingMailbox } = useBackendOperation(
	api.mail.pendingMailbox.claimForInvitation,
	{ label: () => t('invite.accept.claimMailboxOperation') }
);
const { run: claimInboxMemberships } = useBackendOperation(
	api.mail.pendingInboxMembership.claimInboxMemberships,
	{ label: () => t('invite.accept.joinTeamInboxOperation') }
);

// Check authentication and handle invitation on mount
onMounted(async () => {
	if (!invitationId.value) {
		status.value = 'error';
		errorMessage.value = t('invite.accept.errors.missingId');
		return;
	}

	// Check if user is logged in
	const session = await getSession();

	if (!session.data?.user) {
		// User needs to log in first
		status.value = 'login-required';
		return;
	}

	// User is logged in, attempt to accept the invitation
	await handleAcceptInvitation();
});

async function handleAcceptInvitation() {
	status.value = 'accepting';

	try {
		const result = await acceptInvitation({
			invitationId: invitationId.value,
		});

		if (result.error) {
			status.value = 'error';
			errorMessage.value = result.error.message || t('invite.accept.errors.acceptFailed');
			return;
		}

		// Success! The result contains member and invitation info
		// We'll use a generic message since we don't have the org name directly
		organizationName.value = t('invite.accept.defaultOrganization');

		// Best-effort: claim any reserved mailbox the admin set up at invite time. A
		// failure should not block onboarding — the operation module surfaces any
		// genuine fault and we still proceed to success.
		const claim = await claimPendingMailbox({
			invitationId: invitationId.value,
		});
		if (claim.ok) {
			const claimed = claim.result;
			if (claimed.created) {
				claimedMailboxAddress.value = claimed.address;
			} else if ('error' in claimed && claimed.error === 'awaiting_domain') {
				reservedAwaitingAddress.value = claimed.address;
			}
		}

		// Best-effort: materialize any team-inbox memberships reserved for this
		// person, so the shared inbox is already in their sidebar on arrival.
		const inbox = await claimInboxMemberships({});
		if (inbox.ok && inbox.result.claimed.length) {
			claimedInboxAddresses.value = inbox.result.claimed;
		}

		status.value = 'success';

		// Send freshly-joined members into the first-login welcome flow rather than
		// the bare dashboard, so they get the product welcome + resumable onboarding
		// checklist. The welcome middleware would route them there anyway; going
		// straight there avoids a visible bounce.
		setTimeout(() => {
			router.push('/welcome');
		}, 2000);
	} catch (err) {
		status.value = 'error';
		errorMessage.value = err instanceof Error ? err.message : t('invite.accept.errors.unexpected');
	}
}

function redirectToLogin() {
	// Store the current path so we can redirect back after login
	const currentPath = `/invite/accept?id=${encodeURIComponent(invitationId.value)}`;
	router.push(`/auth/login?redirect=${encodeURIComponent(currentPath)}`);
}

function redirectToRegister() {
	// Store the current path so we can redirect back after registration
	const currentPath = `/invite/accept?id=${encodeURIComponent(invitationId.value)}`;
	router.push(`/auth/register?redirect=${encodeURIComponent(currentPath)}`);
}
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex items-center justify-center p-6">
		<div class="w-full max-w-md">
			<!-- Card -->
			<div class="card text-center">
				<!-- Loading State -->
				<template v-if="status === 'loading' || status === 'accepting'">
					<div
						class="p-4 rounded-2xl bg-bg-surface mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:loader-2" class="w-8 h-8 text-brand animate-spin motion-reduce:animate-none" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{
							status === 'loading'
								? t('invite.accept.loadingTitle')
								: t('invite.accept.acceptingTitle')
						}}
					</h1>
					<p class="text-text-secondary">
						{{
							status === 'loading'
								? t('invite.accept.loadingBody')
								: t('invite.accept.acceptingBody')
						}}
					</p>
				</template>

				<!-- Login Required State -->
				<template v-else-if="status === 'login-required'">
					<div
						class="p-4 rounded-2xl bg-bg-surface mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:users" class="w-8 h-8 text-brand" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('invite.accept.loginRequiredTitle') }}
					</h1>
					<p class="text-text-secondary mb-6">
						{{ t('invite.accept.loginRequiredBody') }}
					</p>
					<div class="flex flex-col gap-3">
						<UiButton full-width @click="redirectToLogin">
							{{ t('invite.accept.signInToAccept') }}
						</UiButton>
						<UiButton variant="secondary" full-width @click="redirectToRegister">
							{{ t('invite.accept.createAccount') }}
						</UiButton>
					</div>
				</template>

				<!-- Success State -->
				<template v-else-if="status === 'success'">
					<div
						class="p-4 rounded-2xl bg-success/10 mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:check" class="w-8 h-8 text-success" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('invite.accept.successTitle') }}
					</h1>
					<p class="text-text-secondary mb-2">
						{{
							t('invite.accept.successBody', {
								organization: organizationName || t('invite.accept.defaultWorkspace'),
							})
						}}
					</p>
					<I18nT
						v-if="claimedMailboxAddress"
						keypath="invite.accept.mailboxReady"
						tag="p"
						scope="global"
						class="text-text-secondary mb-2"
					>
						<template #address>
							<code class="text-text-primary">{{ claimedMailboxAddress }}</code>
						</template>
					</I18nT>
					<I18nT
						v-else-if="reservedAwaitingAddress"
						keypath="invite.accept.mailboxReserved"
						tag="p"
						scope="global"
						class="text-text-secondary mb-2"
					>
						<template #address>
							<code class="text-text-primary">{{ reservedAwaitingAddress }}</code>
						</template>
					</I18nT>
					<I18nT
						v-for="addr in claimedInboxAddresses"
						:key="addr"
						keypath="invite.accept.teamInboxAdded"
						tag="p"
						scope="global"
						class="text-text-secondary mb-2"
					>
						<template #address>
							<code class="text-text-primary">{{ addr }}</code>
						</template>
					</I18nT>
					<p class="text-text-tertiary text-sm mb-6">{{ t('invite.accept.redirecting') }}</p>
					<UiButton full-width to="/welcome">{{ t('invite.accept.getStarted') }}</UiButton>
				</template>

				<!-- Error State -->
				<template v-else-if="status === 'error'">
					<div
						class="p-4 rounded-2xl bg-error/10 mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:alert-circle" class="w-8 h-8 text-error" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('invite.accept.errorTitle') }}
					</h1>
					<p class="text-text-secondary mb-6">
						{{ errorMessage }}
					</p>
					<div class="flex flex-col gap-3">
						<UiButton full-width to="/dashboard">{{ t('invite.accept.goToDashboard') }}</UiButton>
						<UiButton variant="secondary" full-width to="/">{{
							t('invite.accept.backToHome')
						}}</UiButton>
					</div>
				</template>
			</div>
		</div>
	</div>
</template>
