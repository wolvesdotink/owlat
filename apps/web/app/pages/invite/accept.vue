<script setup lang="ts">
import { api } from '@owlat/api';
import { acceptInvitation, getSession, sendVerificationEmail } from '~/lib/auth-client';
import { CheckIcon, CircleWarningIcon, MailIcon, UsersIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('invite.accept.pageTitle') });

definePageMeta({
	// No layout - standalone page
});

const route = useRoute();
const router = useRouter();
const { signOut, refetch } = useAuth();

// The workspace's logo above the card: someone opening an invitation
// knows the company that invited them, not the product it runs on.
const { logo } = useRecipientSender();

// Get invitation ID from query params
const invitationId = computed(() => (route.query['id'] as string) || '');

const acceptPath = computed(() => `/invite/accept?id=${encodeURIComponent(invitationId.value)}`);

// The server accepts an invitation only for a confirmed address: existing
// members can see pending invitation IDs, so holding the link proves nothing.
// A new account starts unconfirmed, so it waits here until the link is followed.
const VERIFICATION_REQUIRED_CODE =
	'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION';

// State
const status = ref<
	'loading' | 'accepting' | 'success' | 'error' | 'login-required' | 'verify-email'
>('loading');
const errorMessage = ref('');
const sessionEmail = ref('');
const resendState = ref<'idle' | 'sending' | 'sent' | 'failed'>('idle');
const checkingVerification = ref(false);
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
		errorMessage.value = t('invite.accept.errors.incompleteLink');
		return;
	}

	await checkSessionAndAccept();
});

// Following the confirmation link usually happens in another tab; coming back
// to this one checks again, so the person does not have to.
function onVisibilityChange() {
	if (document.visibilityState === 'visible' && status.value === 'verify-email') {
		void checkSessionAndAccept();
	}
}
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange));
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibilityChange));

async function checkSessionAndAccept() {
	if (checkingVerification.value) return;
	checkingVerification.value = true;
	const waitedForConfirmation = status.value === 'verify-email';
	try {
		// Past the cookie cache: it holds the user as it was at sign-in for a
		// few minutes, so a just-confirmed address would still read unconfirmed
		// here and on the server. This read also rewrites that cache.
		const session = await getSession({ query: { disableCookieCache: true } });
		const user = session.data?.user;

		if (!user) {
			status.value = 'login-required';
			return;
		}

		sessionEmail.value = user.email;
		if (!user.emailVerified) {
			status.value = 'verify-email';
			return;
		}

		// The confirmation link opens this invitation in another tab, which
		// accepts it and makes the workspace active on the shared session. A
		// newcomer had no workspace before, so an active one means they joined.
		await handleAcceptInvitation({
			joinedElsewhere: waitedForConfirmation && !!session.data?.session?.activeOrganizationId,
		});
	} finally {
		checkingVerification.value = false;
	}
}

async function resendVerification() {
	resendState.value = 'sending';
	const result = await sendVerificationEmail({
		email: sessionEmail.value,
		callbackURL: acceptPath.value,
	});
	resendState.value = result.error ? 'failed' : 'sent';
}

async function switchAccount() {
	await signOut({ redirectTo: `/auth/login?redirect=${encodeURIComponent(acceptPath.value)}` });
}

async function handleAcceptInvitation({ joinedElsewhere = false } = {}) {
	status.value = 'accepting';

	try {
		const result = await acceptInvitation({
			invitationId: invitationId.value,
		});

		if (result.error?.code === VERIFICATION_REQUIRED_CODE) {
			status.value = 'verify-email';
			return;
		}

		if (result.error && joinedElsewhere) {
			await router.push('/welcome');
			return;
		}

		if (result.error) {
			status.value = 'error';
			errorMessage.value = acceptErrorCopy(result.error.code);
			return;
		}

		// Success! The result contains member and invitation info
		// We'll use a generic message since we don't have the org name directly
		organizationName.value = t('invite.accept.defaultOrganization');

		// Accepting makes the workspace the session's active one, but the Convex
		// token still names none: the claims below would be refused with "No
		// active organization". Wait for a session and token that carry it.
		const organizationId = result.data?.member?.organizationId;
		if (organizationId) {
			await refetch({
				force: true,
				expected: 'authenticated',
				activeOrganizationId: organizationId,
			});
		}

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
		// straight there avoids a visible bounce. When the card names an address
		// (a claimed mailbox, a team inbox) two seconds is too short to read it, so
		// the person moves on with "Get started" instead.
		if (!hasClaims.value) {
			setTimeout(() => {
				router.push('/welcome');
			}, 2000);
		}
	} catch (err) {
		// Raw client errors are English and technical; they go to the console.
		console.error('[invite] accept failed', err);
		status.value = 'error';
		errorMessage.value = t('invite.accept.errors.unexpected');
	}
}

const hasClaims = computed(
	() =>
		!!claimedMailboxAddress.value ||
		!!reservedAwaitingAddress.value ||
		claimedInboxAddresses.value.length > 0
);

/**
 * The server's refusal in the reader's language. better-auth answers an
 * expired, used or unknown invitation with one code, and a signed-in account
 * that is not the invited address with another; anything else keeps the
 * generic line rather than better-auth's English message.
 */
function acceptErrorCopy(code: string | undefined): string {
	switch (code) {
		case 'INVITATION_NOT_FOUND':
			return t('invite.accept.errors.notFound');
		case 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION':
			return t('invite.accept.errors.wrongRecipient', { email: sessionEmail.value });
		default:
			return t('invite.accept.errors.acceptFailed');
	}
}

function redirectToLogin() {
	router.push(`/auth/login?redirect=${encodeURIComponent(acceptPath.value)}`);
}

function redirectToRegister() {
	router.push(`/auth/register?redirect=${encodeURIComponent(acceptPath.value)}`);
}
</script>

<template>
	<div class="min-h-dvh bg-bg-deep flex items-center justify-center p-6">
		<div class="w-full max-w-md">
			<WorkspaceLogo v-if="logo" :url="logo.url" :dark-url="logo.darkUrl" class="mb-6" />
			<!-- Card -->
			<div class="card text-center">
				<!-- Loading State -->
				<div v-if="status === 'loading' || status === 'accepting'" role="status">
					<div
						class="p-4 rounded-2xl bg-bg-surface mx-auto w-fit mb-6 flex items-center justify-center"
						aria-hidden="true"
					>
						<SpinnerIcon class="w-8 h-8 text-brand" />
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
				</div>

				<!-- Login Required State -->
				<template v-else-if="status === 'login-required'">
					<UiIconBox
						:icon="UsersIcon"
						size="xl"
						rounded="2xl"
						class="mx-auto mb-6"
						aria-hidden="true"
					/>
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

				<!-- Email confirmation pending -->
				<template v-else-if="status === 'verify-email'">
					<UiIconBox
						:icon="MailIcon"
						size="xl"
						rounded="2xl"
						class="mx-auto mb-6"
						aria-hidden="true"
					/>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('invite.accept.verifyEmailTitle') }}
					</h1>
					<I18nT
						keypath="invite.accept.verifyEmailBody"
						tag="p"
						scope="global"
						class="text-text-secondary mb-6"
					>
						<template #email>
							<strong class="text-text-primary">{{ sessionEmail }}</strong>
						</template>
					</I18nT>
					<p
						v-if="resendState === 'sent' || resendState === 'failed'"
						role="status"
						class="text-sm mb-4"
						:class="resendState === 'sent' ? 'text-text-secondary' : 'text-error'"
					>
						{{
							resendState === 'sent'
								? t('invite.accept.verifyEmailResent')
								: t('invite.accept.verifyEmailResendFailed')
						}}
					</p>
					<div class="flex flex-col gap-3">
						<UiButton full-width :loading="checkingVerification" @click="checkSessionAndAccept">
							{{ t('invite.accept.verifyEmailCheck') }}
						</UiButton>
						<UiButton
							variant="secondary"
							full-width
							:loading="resendState === 'sending'"
							@click="resendVerification"
						>
							{{ t('invite.accept.verifyEmailResend') }}
						</UiButton>
						<UiButton variant="ghost" full-width @click="switchAccount">
							{{ t('invite.accept.useDifferentAccount') }}
						</UiButton>
					</div>
				</template>

				<!-- Success State -->
				<template v-else-if="status === 'success'">
					<UiIconBox
						:icon="CheckIcon"
						size="xl"
						variant="success"
						rounded="2xl"
						class="mx-auto mb-6"
						aria-hidden="true"
					/>
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
					<p v-if="!hasClaims" class="text-text-tertiary text-sm mb-6">
						{{ t('invite.accept.redirecting') }}
					</p>
					<div v-else class="mb-6" />
					<UiButton full-width to="/welcome">{{ t('invite.accept.getStarted') }}</UiButton>
				</template>

				<!-- Error State -->
				<template v-else-if="status === 'error'">
					<UiIconBox
						:icon="CircleWarningIcon"
						size="xl"
						variant="error"
						rounded="2xl"
						class="mx-auto mb-6"
						aria-hidden="true"
					/>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('invite.accept.errorTitle') }}
					</h1>
					<p class="text-text-secondary mb-2" role="alert">
						{{ errorMessage }}
					</p>
					<p class="text-sm text-text-tertiary mb-6">{{ t('invite.accept.askForNewLink') }}</p>
					<!-- Neither the dashboard nor the home page helps with a bad invitation
					     (an account with no workspace is bounced from both); signing in as
					     the invited address is the one thing that might. -->
					<div v-if="invitationId" class="flex flex-col gap-3">
						<UiButton v-if="sessionEmail" full-width variant="secondary" @click="switchAccount">
							{{ t('invite.accept.useDifferentAccount') }}
						</UiButton>
						<UiButton v-else full-width variant="secondary" @click="redirectToLogin">
							{{ t('invite.accept.signInToAccept') }}
						</UiButton>
					</div>
				</template>
			</div>
		</div>
	</div>
</template>
