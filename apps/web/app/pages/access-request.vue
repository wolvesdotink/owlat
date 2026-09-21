<script setup lang="ts">
/**
 * Where a signed-in member who belongs to no organization lands.
 *
 * NOT a setup step. This shipped as `/setup/team`, inside the first-run wizard's
 * namespace, which made it read as step six of an installation the operator had
 * already finished — and the person who sees it is usually not the operator at
 * all, but someone who signed in and found themselves outside every org. It is
 * one screen with two outcomes (ask for access, or sign out), so it lives on its
 * own route and says what it is. `/setup/team` still resolves and redirects here.
 */
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('accessRequest.pageTitle') });

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
	{ label: () => t('accessRequest.requestAccessOperation') }
);

async function requestAccess() {
	if (requested.value || sending.value) return;
	const trimmed = note.value.trim();
	const result = await sendRequest(trimmed ? { note: trimmed } : {});
	if (result.ok && result.result.requested) {
		requested.value = true;
	}
}
</script>

<template>
	<div
		class="relative isolate min-h-screen overflow-hidden bg-bg-base flex flex-col items-center justify-center px-4 py-12"
	>
		<UiHeroField />

		<!-- Show loading while checking organization status -->
		<div v-if="orgLoading" class="relative flex flex-col items-center">
			<Icon name="lucide:loader-2" class="w-8 h-8 text-text-tertiary animate-spin motion-reduce:animate-none" />
		</div>

		<!-- Invite-only: no organization yet, but the door isn't locked. -->
		<template v-else-if="!organization">
			<div class="relative mb-8 text-center">
				<h1 class="font-display text-4xl text-text-primary">{{ t('accessRequest.brand') }}</h1>
				<p class="text-text-secondary mt-2">{{ t('accessRequest.invitationRequired') }}</p>
			</div>

			<UiCard class="relative w-full max-w-md">
				<!-- After asking: a clear, honest confirmation. -->
				<div v-if="requested" class="text-center space-y-4">
					<Icon name="lucide:check-circle-2" class="w-12 h-12 text-brand mx-auto" />
					<div class="space-y-1">
						<p class="font-medium text-text-primary">{{ t('accessRequest.requestSentTitle') }}</p>
						<p class="text-text-secondary">
							{{ t('accessRequest.requestSentBody') }}
						</p>
					</div>
					<UiButton variant="ghost" size="sm" @click="signOut()">
						{{ t('accessRequest.signOut') }}
					</UiButton>
				</div>

				<!-- Before asking: request access, or sign out. -->
				<div v-else class="space-y-4">
					<div class="text-center space-y-3">
						<Icon name="lucide:mail" class="w-12 h-12 text-text-tertiary mx-auto" />
						<p class="text-text-secondary">
							{{ t('accessRequest.inviteExplainer') }}
						</p>
					</div>

					<UiTextarea
						v-model="note"
						:rows="3"
						:max-length="MAX_NOTE_LENGTH"
						:label="t('accessRequest.noteLabel')"
						:placeholder="t('accessRequest.notePlaceholder')"
					/>

					<div class="flex flex-col gap-2">
						<UiButton :loading="sending" class="w-full" @click="requestAccess">
							{{ t('accessRequest.requestAccess') }}
						</UiButton>
						<UiButton variant="ghost" size="sm" @click="signOut()">
							{{ t('accessRequest.signOut') }}
						</UiButton>
					</div>
				</div>
			</UiCard>
		</template>
	</div>
</template>
