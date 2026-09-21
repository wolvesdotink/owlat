<script setup lang="ts">
/**
 * The send-path verdict card: can this deployment send mail, and — when it
 * cannot — the paste-ready remedy for the environment variables the active
 * transport is missing.
 *
 * Extracted from `pages/dashboard/admin/delivery/transport.vue`, which crossed
 * the 500-LOC split guideline. Names only ever reach here: `getStatus` returns
 * the PRESENCE of each required variable, never its value, so nothing secret
 * can be rendered or copied out of this card.
 */
defineProps<{
	canSend: boolean;
	/** `.env` skeleton for the missing vars; empty string hides the remedy. */
	envSnippet: string;
	/** Example CLI invocation for the first missing var. */
	envSetCommand: string;
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-6 flex items-start gap-4" :class="canSend ? 'bg-success/5' : 'bg-error/5'">
			<div
				class="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
				:class="canSend ? 'bg-success/15 text-success' : 'bg-error/15 text-error'"
			>
				<Icon
					:name="canSend ? 'lucide:check-circle-2' : 'lucide:alert-triangle'"
					class="w-6 h-6"
				/>
			</div>
			<div class="flex-1 min-w-0">
				<h2 class="text-lg font-semibold" :class="canSend ? 'text-success' : 'text-error'">
					{{
						canSend
							? t('dashboard.admin.delivery.transport.canSend.yes')
							: t('dashboard.admin.delivery.transport.canSend.no')
					}}
				</h2>
				<p class="text-sm text-text-secondary mt-1">
					<template v-if="canSend">
						{{ t('dashboard.admin.delivery.transport.canSend.yesBody') }}
					</template>
					<I18nT
						v-else
						keypath="dashboard.admin.delivery.transport.canSend.noBody"
						scope="global"
					>
						<template #envVar><code class="text-text-primary">EMAIL_PROVIDER</code></template>
					</I18nT>
				</p>

				<!-- Actionable remedy: paste-ready .env skeleton + CLI command for the
				     MISSING vars. Names only — no secret value is ever rendered. -->
				<div v-if="!canSend && envSnippet" class="mt-4 space-y-4">
					<!-- .env skeleton -->
					<div>
						<div class="flex items-center justify-between mb-2">
							<I18nT
								keypath="dashboard.admin.delivery.transport.env.addToEnv"
								tag="p"
								class="text-xs font-medium text-text-primary"
								scope="global"
							>
								<template #file><code class="text-text-primary">.env</code></template>
							</I18nT>
							<UiButton
								variant="ghost"
								size="sm"
								:title="
									isCopied('env-snippet')
										? t('common.copied')
										: t('dashboard.admin.delivery.transport.env.copySnippet')
								"
								@click="copy(envSnippet, 'env-snippet')"
							>
								<Icon
									:name="isCopied('env-snippet') ? 'lucide:check' : 'lucide:copy'"
									class="w-3.5 h-3.5"
									:class="isCopied('env-snippet') ? 'text-success' : ''"
								/>
								{{ isCopied('env-snippet') ? t('common.copied') : t('common.copy') }}
							</UiButton>
						</div>
						<pre
							class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
							>{{ envSnippet }}</pre>
						<p class="text-xs text-text-tertiary mt-1.5">
							{{ t('dashboard.admin.delivery.transport.env.blankValues') }}
						</p>
					</div>

					<!-- CLI command -->
					<div>
						<div class="flex items-center justify-between mb-2">
							<p class="text-xs font-medium text-text-primary">
								{{ t('dashboard.admin.delivery.transport.env.cliTitle') }}
							</p>
							<UiButton
								variant="ghost"
								size="sm"
								:title="
									isCopied('env-cmd')
										? t('common.copied')
										: t('dashboard.admin.delivery.transport.env.copyCommand')
								"
								@click="copy(envSetCommand, 'env-cmd')"
							>
								<Icon
									:name="isCopied('env-cmd') ? 'lucide:check' : 'lucide:copy'"
									class="w-3.5 h-3.5"
									:class="isCopied('env-cmd') ? 'text-success' : ''"
								/>
								{{ isCopied('env-cmd') ? t('common.copied') : t('common.copy') }}
							</UiButton>
						</div>
						<pre
							class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
							>{{ envSetCommand }}</pre>
						<I18nT
							keypath="dashboard.admin.delivery.transport.env.cliHint"
							tag="p"
							class="text-xs text-text-tertiary mt-1.5"
							scope="global"
						>
							<template #command>
								<code class="text-text-primary">owlat-setup env --show</code>
							</template>
							<template #guideLink>
								<a
									href="https://docs.owlat.app/developer/environment-variables"
									target="_blank"
									rel="noopener"
									class="text-brand hover:text-brand-hover underline"
									>{{ t('dashboard.admin.delivery.transport.env.guideLink') }}</a
								>
							</template>
						</I18nT>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
