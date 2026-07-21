<script setup lang="ts">
/** Staged real-message diagnostic for the active delivery transport. */
import { api } from '@owlat/api';
import { isValidEmail } from '~/utils/validation';

const props = defineProps<{
	canSend: boolean;
	lastTestSucceededAt?: number | null;
}>();

const { user } = useAuth();
const { showToast } = useToast();

const lastTestLabel = computed(() =>
	props.lastTestSucceededAt ? new Date(props.lastTestSucceededAt).toLocaleString() : null
);

const testEmail = ref('');
const testError = ref('');
const testStages = ref<
	Array<{
		key: string;
		label: string;
		status: 'passed' | 'failed' | 'not_run';
		detail: string;
	}>
>([]);
const testReceipt = ref<{
	provider: string;
	providerMessageId: string;
	latencyMs: number;
	attempts: number;
} | null>(null);

const stageIcon = {
	passed: 'lucide:check-circle-2',
	failed: 'lucide:x-circle',
	not_run: 'lucide:circle-dashed',
} as const;
const stageClass = {
	passed: 'text-success',
	failed: 'text-error',
	not_run: 'text-text-tertiary',
} as const;

watch(
	user,
	(u) => {
		if (u?.email && !testEmail.value) testEmail.value = u.email;
	},
	{ immediate: true }
);

const { run: sendTest, isLoading: isSending } = useBackendOperation(api.delivery.status.sendTest, {
	label: 'Send test email',
	type: 'action',
});

async function handleSendTest() {
	testError.value = '';
	testStages.value = [];
	testReceipt.value = null;
	const to = testEmail.value.trim();
	if (!isValidEmail(to)) {
		testError.value = 'Enter a valid recipient email address.';
		return;
	}
	const result = await sendTest({ to });
	if (result === undefined) return;
	testStages.value = result.stages;
	if (
		result.provider &&
		result.providerMessageId &&
		result.latencyMs !== null &&
		result.attempts !== null
	) {
		testReceipt.value = {
			provider: result.provider,
			providerMessageId: result.providerMessageId,
			latencyMs: result.latencyMs,
			attempts: result.attempts,
		};
	}
	if (result.success) showToast(`Test email accepted for ${to}`);
	else testError.value = result.error ?? 'Test send failed.';
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:mail-check" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Send a test email</h2>
					<p class="text-sm text-text-secondary">
						Trace readiness through provider acceptance with a real message
					</p>
				</div>
			</div>
		</template>

		<div class="p-6 space-y-4">
			<div class="flex flex-col sm:flex-row sm:items-end gap-3 max-w-xl">
				<div class="flex-1">
					<UiInput
						v-model="testEmail"
						type="email"
						label="Recipient"
						placeholder="you@example.com"
						:error="testError"
						:disabled="isSending"
					/>
				</div>
				<UiButton :loading="isSending" :disabled="isSending || !canSend" @click="handleSendTest">
					<template #iconLeft>
						<Icon v-if="!isSending" name="lucide:send" class="w-4 h-4" />
					</template>
					{{ isSending ? 'Sending…' : 'Send test email' }}
				</UiButton>
			</div>

			<div
				v-if="testStages.length"
				class="max-w-xl rounded-lg border border-border-subtle divide-y divide-border-subtle"
			>
				<div
					v-for="stage in testStages"
					:key="stage.key"
					class="flex items-start gap-3 px-3 py-2.5"
				>
					<Icon
						:name="stageIcon[stage.status]"
						class="w-4 h-4 mt-0.5 shrink-0"
						:class="stageClass[stage.status]"
					/>
					<div class="min-w-0">
						<p class="text-sm font-medium text-text-primary">{{ stage.label }}</p>
						<p class="text-xs text-text-tertiary break-all">{{ stage.detail }}</p>
					</div>
				</div>
			</div>

			<p v-if="testReceipt" class="max-w-xl text-xs text-text-tertiary break-all">
				{{ testReceipt.provider }} accepted message {{ testReceipt.providerMessageId }} in
				{{ testReceipt.latencyMs }} ms after {{ testReceipt.attempts }}
				{{ testReceipt.attempts === 1 ? 'attempt' : 'attempts' }}. Recipient delivery is
				<em>not</em> confirmed by this acceptance; verify it in the recipient inbox or provider
				feedback.
			</p>

			<p v-if="!canSend" class="text-xs text-warning flex items-center gap-1.5">
				<Icon name="lucide:alert-circle" class="w-3.5 h-3.5" />
				Configure a delivery provider before sending a test.
			</p>
			<p v-else-if="lastTestLabel" class="text-xs text-success flex items-center gap-1.5">
				<Icon name="lucide:check" class="w-3.5 h-3.5" />
				Last successful test: {{ lastTestLabel }}
			</p>
		</div>
	</UiCard>
</template>
