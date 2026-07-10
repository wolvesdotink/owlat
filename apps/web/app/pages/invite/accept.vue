<script setup lang="ts">
import { api } from '@owlat/api';
import { acceptInvitation, getSession } from '~/lib/auth-client';

useHead({ title: 'Accept Invitation \u2014 Owlat' });

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
const claimedInboxAddresses = ref<string[]>([]);

const { run: claimPendingMailbox } = useBackendOperation(
	api.mail.pendingMailbox.claimForInvitation,
	{ label: 'Claim mailbox' }
);
const { run: claimInboxMemberships } = useBackendOperation(
	api.mail.pendingMailbox.claimInboxMemberships,
	{ label: 'Join team inbox' }
);

// Check authentication and handle invitation on mount
onMounted(async () => {
	if (!invitationId.value) {
		status.value = 'error';
		errorMessage.value = 'Invalid invitation link. No invitation ID provided.';
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
			errorMessage.value = result.error.message || 'Failed to accept invitation';
			return;
		}

		// Success! The result contains member and invitation info
		// We'll use a generic message since we don't have the org name directly
		organizationName.value = 'the team';

		// Best-effort: claim any reserved mailbox the admin set up at invite time. A
		// failure should not block onboarding — the operation module surfaces any
		// genuine fault and we still proceed to success.
		const claim = await claimPendingMailbox({
			invitationId: invitationId.value,
		});
		if (claim?.created) {
			claimedMailboxAddress.value = claim.address;
		}

		// Best-effort: materialize any team-inbox memberships reserved for this
		// person, so the shared inbox is already in their sidebar on arrival.
		const inbox = await claimInboxMemberships({});
		if (inbox?.claimed?.length) {
			claimedInboxAddresses.value = inbox.claimed;
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
		errorMessage.value = err instanceof Error ? err.message : 'An unexpected error occurred';
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
						<Icon name="lucide:loader-2" class="w-8 h-8 text-brand animate-spin" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">
						{{ status === 'loading' ? 'Loading...' : 'Accepting Invitation...' }}
					</h1>
					<p class="text-text-secondary">
						{{ status === 'loading' ? 'Please wait...' : 'Setting up your team access...' }}
					</p>
				</template>

				<!-- Login Required State -->
				<template v-else-if="status === 'login-required'">
					<div
						class="p-4 rounded-2xl bg-bg-surface mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:users" class="w-8 h-8 text-brand" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">You're Invited!</h1>
					<p class="text-text-secondary mb-6">
						Sign in or create an account to accept this team invitation.
					</p>
					<div class="flex flex-col gap-3">
						<button class="btn btn-primary w-full" @click="redirectToLogin">
							Sign In to Accept
						</button>
						<button class="btn btn-secondary w-full" @click="redirectToRegister">
							Create Account
						</button>
					</div>
				</template>

				<!-- Success State -->
				<template v-else-if="status === 'success'">
					<div
						class="p-4 rounded-2xl bg-success/10 mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:check" class="w-8 h-8 text-success" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">Welcome to the Team!</h1>
					<p class="text-text-secondary mb-2">
						You've successfully joined {{ organizationName || 'the organization' }}.
					</p>
					<p v-if="claimedMailboxAddress" class="text-text-secondary mb-2">
						Your mailbox at
						<code class="text-text-primary">{{ claimedMailboxAddress }}</code>
						is ready.
					</p>
					<p v-for="addr in claimedInboxAddresses" :key="addr" class="text-text-secondary mb-2">
						The team inbox
						<code class="text-text-primary">{{ addr }}</code>
						is in your sidebar.
					</p>
					<p class="text-text-tertiary text-sm mb-6">Taking you in...</p>
					<NuxtLink to="/welcome" class="btn btn-primary w-full"> Get started </NuxtLink>
				</template>

				<!-- Error State -->
				<template v-else-if="status === 'error'">
					<div
						class="p-4 rounded-2xl bg-error/10 mx-auto w-fit mb-6 flex items-center justify-center"
					>
						<Icon name="lucide:alert-circle" class="w-8 h-8 text-error" />
					</div>
					<h1 class="text-xl font-semibold text-text-primary mb-2">Invitation Error</h1>
					<p class="text-text-secondary mb-6">
						{{ errorMessage }}
					</p>
					<div class="flex flex-col gap-3">
						<NuxtLink to="/dashboard" class="btn btn-primary w-full"> Go to Dashboard </NuxtLink>
						<NuxtLink to="/" class="btn btn-secondary w-full"> Back to Home </NuxtLink>
					</div>
				</template>
			</div>
		</div>
	</div>
</template>
