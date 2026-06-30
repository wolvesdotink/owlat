<script setup lang="ts">
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
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4">
		<!-- Show loading while checking organization status -->
		<div v-if="orgLoading" class="flex flex-col items-center">
			<Icon name="lucide:loader-2" class="w-8 h-8 text-text-tertiary animate-spin" />
		</div>

		<!-- Invite-only message — users need an invitation to join -->
		<template v-else-if="!organization">
			<div class="mb-8 text-center">
				<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
				<p class="text-text-secondary mt-2">Invitation required</p>
			</div>

			<UiCard class="w-full max-w-md">
				<div class="text-center space-y-4">
					<Icon name="lucide:mail" class="w-12 h-12 text-text-tertiary mx-auto" />
					<p class="text-text-secondary">
						You need an invitation to join this instance. Ask your administrator to send you one.
					</p>
					<UiButton variant="ghost" size="sm" @click="signOut()">
						Sign out
					</UiButton>
				</div>
			</UiCard>
		</template>
	</div>
</template>
