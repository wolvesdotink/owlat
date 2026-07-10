<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Team Setup — Owlat' });

definePageMeta({
	middleware: 'auth',
});

const { signOut } = useAuth();
const router = useRouter();
const { organization, isLoading: orgLoading } = useOrganizationContext();

// Redirect to dashboard if user already has an organization
watch(
	[organization, orgLoading],
	([orgValue, loading]) => {
		if (!loading && orgValue) {
			router.push('/dashboard');
		}
	},
	{ immediate: true }
);

// An orgless-but-signed-in user is invite-only here. Rather than dead-ending at
// "ask your administrator" with sign-out as the only action, they can ask for
// access in one click — a notification the admins see on their dashboard. The
// request never grants membership; an admin still invites them the normal way.
const MAX_NOTE_LENGTH = 500;
const note = ref('');
const requested = ref(false);

const { run: sendRequest, isLoading: sending } = useBackendOperation(
	api.auth.accessRequest.request,
	{ label: 'Request access' }
);

async function requestAccess() {
	if (requested.value || sending.value) return;
	const trimmed = note.value.trim();
	const result = await sendRequest(trimmed ? { note: trimmed } : {});
	if (result?.requested) {
		requested.value = true;
	}
}
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4 py-12">
		<!-- Show loading while checking organization status -->
		<div v-if="orgLoading" class="flex flex-col items-center">
			<Icon name="lucide:loader-2" class="w-8 h-8 text-text-tertiary animate-spin" />
		</div>

		<!-- Invite-only: no organization yet, but the door isn't locked. -->
		<template v-else-if="!organization">
			<div class="mb-8 text-center">
				<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
				<p class="text-text-secondary mt-2">Invitation required</p>
			</div>

			<UiCard class="w-full max-w-md">
				<!-- After asking: a clear, honest confirmation. -->
				<div v-if="requested" class="text-center space-y-4">
					<Icon name="lucide:check-circle-2" class="w-12 h-12 text-brand mx-auto" />
					<div class="space-y-1">
						<p class="font-medium text-text-primary">Request sent</p>
						<p class="text-text-secondary">
							An administrator has been notified. You'll get an invitation by email once they grant
							you access — no need to ask again.
						</p>
					</div>
					<UiButton variant="ghost" size="sm" @click="signOut()"> Sign out </UiButton>
				</div>

				<!-- Before asking: request access, or sign out. -->
				<div v-else class="space-y-4">
					<div class="text-center space-y-3">
						<Icon name="lucide:mail" class="w-12 h-12 text-text-tertiary mx-auto" />
						<p class="text-text-secondary">
							You need an invitation to join this instance. Ask an administrator to send you one —
							you can request it right here.
						</p>
					</div>

					<UiTextarea
						v-model="note"
						:rows="3"
						:max-length="MAX_NOTE_LENGTH"
						label="Add a note (optional)"
						placeholder="e.g. I'm on the marketing team and need access to send campaigns."
					/>

					<div class="flex flex-col gap-2">
						<UiButton :loading="sending" class="w-full" @click="requestAccess">
							Request access
						</UiButton>
						<UiButton variant="ghost" size="sm" @click="signOut()"> Sign out </UiButton>
					</div>
				</div>
			</UiCard>
		</template>
	</div>
</template>
