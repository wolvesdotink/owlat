<script setup lang="ts">
/**
 * The one way a Delivery page asks an operator for an environment variable.
 *
 * Credentials live in the server's `.env` by design, so a page that needs one
 * cannot set it. What it can do is hand over exactly what to paste, the exact
 * `owlat` command that does the same, and then notice on its own when the
 * server sees the value — so the operator is not left refreshing a page that
 * still says "missing" after the restart.
 *
 * The page owns the question "is it connected?" (it already reads a query that
 * answers it); this component only asks it to look again, by emitting
 * `refresh` on an interval while the answer is no. Names only ever reach here:
 * both blocks end at the `=` / `<value>`, never at a secret.
 */
import {
	buildDeliveryEnvSnippet,
	buildEnvCliCommands,
	ENV_CONNECTION_POLL_MS,
} from '~/utils/deliveryEnvSnippet';

const props = withDefaults(
	defineProps<{
		/** Variable names the server still needs, in the order to show them. */
		variables: readonly string[];
		/** The server reports the change as live. */
		connected: boolean;
		/** Sentence shown once connected; defaults to "Connected". */
		connectedLabel?: string;
		/** Poll cadence while waiting. */
		pollIntervalMs?: number;
	}>(),
	{ connectedLabel: undefined, pollIntervalMs: ENV_CONNECTION_POLL_MS }
);

const emit = defineEmits<{ refresh: [] }>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

const envSnippet = computed(() => buildDeliveryEnvSnippet(props.variables));
const cliCommands = computed(() => buildEnvCliCommands(props.variables));
const isWaiting = computed(() => !props.connected && envSnippet.value !== '');

let timer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
}

watch(
	isWaiting,
	(waiting) => {
		stopPolling();
		if (waiting) timer = setInterval(() => emit('refresh'), props.pollIntervalMs);
	},
	{ immediate: true }
);

onBeforeUnmount(stopPolling);
</script>

<template>
	<div class="space-y-4" data-testid="env-setup-steps">
		<p
			v-if="connected"
			class="inline-flex items-center gap-1.5 text-sm font-medium text-success"
			role="status"
			data-testid="env-setup-connected"
		>
			<Icon name="lucide:check-circle-2" class="h-4 w-4" />
			{{ connectedLabel ?? t('components.delivery.envSetupSteps.connected') }}
		</p>

		<template v-else-if="isWaiting">
			<div>
				<div class="mb-2 flex items-center justify-between gap-3">
					<p class="text-xs font-medium text-text-primary">
						{{ t('components.delivery.envSetupSteps.envTitle') }}
					</p>
					<UiButton
						variant="ghost"
						size="sm"
						:aria-label="t('components.delivery.envSetupSteps.copyEnv')"
						data-testid="env-setup-copy-env"
						@click="copy(envSnippet, 'env-setup-env')"
					>
						<Icon
							:name="isCopied('env-setup-env') ? 'lucide:check' : 'lucide:copy'"
							class="h-3.5 w-3.5"
							:class="isCopied('env-setup-env') ? 'text-success' : ''"
						/>
						{{ isCopied('env-setup-env') ? t('common.copied') : t('common.copy') }}
					</UiButton>
				</div>
				<pre
					class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
					data-testid="env-setup-env"
					>{{ envSnippet }}</pre>
				<p class="mt-1.5 text-xs text-text-tertiary">
					{{ t('components.delivery.envSetupSteps.blankValues') }}
				</p>
			</div>

			<div>
				<div class="mb-2 flex items-center justify-between gap-3">
					<p class="text-xs font-medium text-text-primary">
						{{ t('components.delivery.envSetupSteps.cliTitle') }}
					</p>
					<UiButton
						variant="ghost"
						size="sm"
						:aria-label="t('components.delivery.envSetupSteps.copyCommands')"
						data-testid="env-setup-copy-cli"
						@click="copy(cliCommands, 'env-setup-cli')"
					>
						<Icon
							:name="isCopied('env-setup-cli') ? 'lucide:check' : 'lucide:copy'"
							class="h-3.5 w-3.5"
							:class="isCopied('env-setup-cli') ? 'text-success' : ''"
						/>
						{{ isCopied('env-setup-cli') ? t('common.copied') : t('common.copy') }}
					</UiButton>
				</div>
				<pre
					class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
					data-testid="env-setup-cli"
					>{{ cliCommands }}</pre>
			</div>

			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<p
					class="inline-flex items-center gap-1.5 text-xs text-text-secondary"
					role="status"
					aria-live="polite"
					data-testid="env-setup-waiting"
				>
					<Icon
						name="lucide:loader-2"
						class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>
					{{ t('components.delivery.envSetupSteps.waiting') }}
				</p>
				<UiButton
					variant="ghost"
					size="sm"
					data-testid="env-setup-check-now"
					@click="emit('refresh')"
				>
					{{ t('components.delivery.envSetupSteps.checkNow') }}
				</UiButton>
				<a
					href="https://docs.owlat.app/developer/environment-variables"
					target="_blank"
					rel="noopener"
					class="text-xs text-brand underline hover:text-brand-hover"
					>{{ t('components.delivery.envSetupSteps.guideLink') }}</a
				>
			</div>
		</template>
	</div>
</template>
