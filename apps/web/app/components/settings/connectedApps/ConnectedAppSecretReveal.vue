<script setup lang="ts">
/**
 * One-time reveal of a connected app's shared secret. The plaintext secret is
 * returned by the register / rotate action exactly once and is never fetchable
 * again, so this dialog is deliberately non-dismissible except through an
 * explicit "Done": the operator must acknowledge they have copied it. The
 * backend never stores or re-serves the plaintext.
 */
const { t } = useI18n();

const props = defineProps<{
	open: boolean;
	secret: string | null;
	appName?: string | null;
	/** `created` on first registration, `rotated` after a secret rotation. */
	context: 'created' | 'rotated';
}>();

const emit = defineEmits<{ close: [] }>();

const { copy, isCopied, reset } = useCopyToClipboard();
const { showToast } = useToast();
const COPY_KEY = 'connected-app-secret';
const copied = computed(() => isCopied(COPY_KEY));

const heading = computed(() =>
	props.context === 'created' ? t('components.settings.connectedApps.connectedAppSecretReveal.headingCreated') : t('components.settings.connectedApps.connectedAppSecretReveal.headingRotated')
);

// Reset the copied indicator whenever a fresh secret is shown so a prior "Copied!"
// state can't bleed across reveals.
watch(
	() => props.secret,
	() => reset()
);

async function copySecret() {
	if (!props.secret) return;
	const ok = await copy(props.secret, COPY_KEY);
	if (!ok) showToast(t('components.settings.connectedApps.connectedAppSecretReveal.copyFailed'), 'error');
}

function done() {
	emit('close');
}
</script>

<template>
	<UiModal
		:open="open && !!secret"
		size="lg"
		:closable="false"
		persistent
		@update:open="(v: boolean) => !v && done()"
	>
		<template v-if="secret">
			<div class="flex items-center gap-3 mb-6">
				<UiIconBox icon="lucide:key-round" size="sm" variant="success" rounded="lg" />
				<h2 class="text-lg font-semibold text-text-primary">{{ heading }}</h2>
			</div>

			<div class="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
				<div class="flex items-start gap-3">
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-warning">{{ t('components.settings.connectedApps.connectedAppSecretReveal.copyNow') }}</p>
						<p class="text-sm text-warning/80 mt-1">
							{{ t('components.settings.connectedApps.connectedAppSecretReveal.onlyTimeShown') }}
							<template v-if="context === 'rotated'">
								{{ t('components.settings.connectedApps.connectedAppSecretReveal.previousSecretStopped') }}
							</template>
						</p>
					</div>
				</div>
			</div>

			<div v-if="appName" class="mb-4">
				<label class="label">{{ t('components.settings.connectedApps.connectedAppSecretReveal.appLabel') }}</label>
				<p class="text-text-primary font-medium">{{ appName }}</p>
			</div>

			<div>
				<label id="connected-app-secret-label" class="label">{{ t('components.settings.connectedApps.connectedAppSecretReveal.secretLabel') }}</label>
				<div class="flex items-center gap-2">
					<code
						aria-labelledby="connected-app-secret-label"
						class="flex-1 px-4 py-3 rounded-lg bg-bg-deep text-text-primary text-sm font-mono break-all border border-border-subtle"
					>
						{{ secret }}
					</code>
					<UiButton variant="secondary" class="shrink-0" @click="copySecret">
						<Icon
							:name="copied ? 'lucide:check' : 'lucide:copy'"
							class="w-4 h-4"
							:class="copied ? 'text-success' : ''"
						/>
						{{ copied ? t('components.settings.connectedApps.connectedAppSecretReveal.copied') : t('common.copy') }}
					</UiButton>
				</div>
			</div>
		</template>

		<template #footer>
			<UiButton variant="primary" @click="done">{{ t('common.done') }}</UiButton>
		</template>
	</UiModal>
</template>
