<script setup lang="ts">
import {
	SETUP_WIZARD_STEPS,
	setupStepPath,
	validateAdmin,
	adminIsValid,
	type SetupStepId,
} from '~/composables/useSetupWizard';

definePageMeta({ layout: false });
useHead({ title: 'Owlat setup — Admin account' });

const router = useRouter();
const { admin } = useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'admin');

// Jump back to an already-completed step from the indicator (draft is persisted).
function goToStep(stepId: string) {
	router.push(setupStepPath(stepId as SetupStepId));
}

const submitted = ref(false);
// Track touched fields so an error only shows after the user has left the field
// (or after an advance attempt), not while they're still typing.
const touched = reactive({ email: false, password: false });

const errors = computed(() => validateAdmin(admin.value));
const emailError = computed(() =>
	submitted.value || touched.email ? errors.value.email : undefined
);
const passwordError = computed(() =>
	submitted.value || touched.password ? errors.value.password : undefined
);

function next() {
	submitted.value = true;
	if (!adminIsValid(admin.value)) return;
	router.push('/setup/review');
}
</script>

<template>
	<div class="min-h-screen bg-bg-base text-text-primary">
		<div class="mx-auto max-w-xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="text-sm font-medium text-text-secondary tracking-wide uppercase"
					>Owlat setup</span
				>
			</div>

			<UiStepIndicator
				class="mb-10"
				:steps="SETUP_WIZARD_STEPS"
				:get-step-status="getStepStatus as (stepId: string) => 'completed' | 'current' | 'upcoming'"
				:is-connector-highlighted="isConnectorHighlighted"
				:on-step-click="goToStep"
			/>

			<header class="mb-6">
				<h1 class="font-display text-3xl mb-2">Admin account</h1>
				<p class="text-text-secondary leading-relaxed">
					The first user. You can invite teammates from the dashboard after launch.
				</p>
			</header>

			<UiCard padding="lg">
				<form class="space-y-5" @submit.prevent="next">
					<UiInput
						v-model="admin.email"
						type="email"
						label="Email"
						placeholder="you@example.com"
						autocomplete="email"
						autofocus
						required
						:error="emailError"
						@blur="touched.email = true"
					/>
					<UiInput
						v-model="admin.name"
						label="Display name"
						placeholder="Alex Operator"
						autocomplete="name"
					/>
					<UiInput
						v-model="admin.password"
						type="password"
						label="Password"
						placeholder="At least 12 characters"
						autocomplete="new-password"
						required
						:error="passwordError"
						help-text="At least 12 characters."
						@blur="touched.password = true"
					/>
				</form>
			</UiCard>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" @click="router.push('/setup/email')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					Back
				</UiButton>
				<UiButton @click="next">
					Next: Review
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
