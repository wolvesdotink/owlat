<script setup lang="ts">
/**
 * A flag's operator-facing facts — its key, the env vars and Docker profiles it
 * needs, a plugin's package and requested access — folded into a collapsed
 * "Technical details" row. Self-hosters need these for the CLI and `.env`;
 * everyone else only needs the switch label and description above it.
 */
import type { FeatureFlagDefinition } from '@owlat/shared/featureFlags';

defineProps<{ definition: FeatureFlagDefinition }>();

const { t } = useI18n();
</script>

<template>
	<details class="mt-1.5 group" data-testid="feature-flag-technical-details">
		<summary
			class="text-xs text-text-tertiary hover:text-text-secondary cursor-pointer select-none w-fit rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
		>
			{{ t('components.settings.featureFlagMetadata.summary') }}
		</summary>
		<dl class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
			<dt class="text-text-tertiary">{{ t('components.settings.featureFlagMetadata.flagKey') }}</dt>
			<dd class="font-mono text-text-secondary break-all">{{ definition.key }}</dd>
			<template v-if="definition.requiredEnvVars?.length">
				<dt class="text-text-tertiary">
					{{ t('components.settings.featureFlagMetadata.requiredEnv') }}
				</dt>
				<dd class="font-mono text-text-secondary break-all">
					{{ definition.requiredEnvVars.join(', ') }}
				</dd>
			</template>
			<template v-if="definition.dockerProfiles?.length">
				<dt class="text-text-tertiary">
					{{ t('components.settings.featureFlagMetadata.dockerProfile') }}
				</dt>
				<dd class="font-mono text-text-secondary break-all">
					{{ definition.dockerProfiles.join(', ') }}
				</dd>
			</template>
			<template v-if="definition.pluginPackageName">
				<dt class="text-text-tertiary">
					{{ t('components.settings.featureFlagMetadata.package') }}
				</dt>
				<dd class="font-mono text-text-secondary break-all">{{ definition.pluginPackageName }}</dd>
			</template>
			<template v-if="definition.requiredCapabilities?.length">
				<dt class="text-text-tertiary">
					{{ t('components.settings.featureFlagMetadata.requestedAccess') }}
				</dt>
				<dd class="font-mono text-text-secondary break-all">
					{{ definition.requiredCapabilities.join(', ') }}
				</dd>
			</template>
		</dl>
	</details>
</template>
