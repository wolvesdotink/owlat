<script setup lang="ts">
/** Staged real-message diagnostic for the active delivery transport. */
import { api } from '@owlat/api';
import { isValidEmail } from '~/utils/validation';

const props = defineProps<{
	canSend: boolean;
	lastTestSucceededAt?: number | null;
}>();

/**
 * Emitted once a test send settles, so an embedding flow (the transport
 * connection wizard's step 2) can advance on the SAME machinery instead of
 * running a parallel test path beside it. Purely additive: the card's standalone
 * use on the delivery config page ignores it.
 */
const emit = defineEmits<{ result: [{ success: boolean }] }>();

const { t, locale } = useI18n();
const { user } = useAuth();
const { showToast } = useToast();

const lastTestLabel = computed(() =>
	props.lastTestSucceededAt
		? new Date(props.lastTestSucceededAt).toLocaleString(locale.value)
		: null
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
	label: () => t('components.delivery.testSendCard.operationLabel'),
	type: 'action',
});

async function handleSendTest() {
	testError.value = '';
	testStages.value = [];
	testReceipt.value = null;
	const to = testEmail.value.trim();
	if (!isValidEmail(to)) {
		testError.value = t('components.delivery.testSendCard.invalidRecipient');
		return;
	}
	const result = await sendTest({ to });
	if (!result.ok) return;
	testStages.value = result.result.stages;
	if (
		result.result.provider &&
		result.result.providerMessageId &&
		result.result.latencyMs !== null &&
		result.result.attempts !== null
	) {
		testReceipt.value = {
			provider: result.result.provider,
			providerMessageId: result.result.providerMessageId,
			latencyMs: result.result.latencyMs,
			attempts: result.result.attempts,
		};
	}
	if (result.result.success)
		showToast(t('components.delivery.testSendCard.acceptedToast', { email: to }));
	else testError.value = result.result.error ?? t('components.delivery.testSendCard.sendFailed');
	emit('result', { success: result.result.success });
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:mail-check" size="sm" variant="surface" rounded="lg" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('components.delivery.testSendCard.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.delivery.testSendCard.subtitle') }}
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
						:label="t('components.delivery.testSendCard.recipientLabel')"
						:placeholder="t('components.delivery.testSendCard.recipientPlaceholder')"
						:error="testError"
						:disabled="isSending"
					/>
				</div>
				<UiButton :loading="isSending" :disabled="isSending || !canSend" @click="handleSendTest">
					<template #iconLeft>
						<Icon v-if="!isSending" name="lucide:send" class="w-4 h-4" />
					</template>
					{{
						isSending
							? t('components.delivery.testSendCard.sending')
							: t('components.delivery.testSendCard.sendButton')
					}}
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

			<I18nT
				v-if="testReceipt"
				keypath="components.delivery.testSendCard.receipt"
				tag="p"
				scope="global"
				class="max-w-xl text-xs text-text-tertiary break-all"
			>
				<template #provider>{{ testReceipt.provider }}</template>
				<template #messageId>{{ testReceipt.providerMessageId }}</template>
				<template #latencyMs>{{ testReceipt.latencyMs }}</template>
				<template #attempts>
					{{ t('components.delivery.testSendCard.receiptAttempts', testReceipt.attempts) }}
				</template>
				<template #not>
					<em>{{ t('components.delivery.testSendCard.receiptNot') }}</em>
				</template>
			</I18nT>

			<p v-if="!canSend" class="text-xs text-warning flex items-center gap-1.5">
				<Icon name="lucide:alert-circle" class="w-3.5 h-3.5" />
				{{ t('components.delivery.testSendCard.needsProvider') }}
			</p>
			<p v-else-if="lastTestLabel" class="text-xs text-success flex items-center gap-1.5">
				<Icon name="lucide:check" class="w-3.5 h-3.5" />
				{{ t('components.delivery.testSendCard.lastSuccess', { timestamp: lastTestLabel }) }}
			</p>
		</div>
	</UiCard>
</template>
