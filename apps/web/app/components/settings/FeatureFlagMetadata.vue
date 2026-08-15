<script setup lang="ts">
import type { FeatureFlagDefinition } from '@owlat/shared/featureFlags';

defineProps<{ definition: FeatureFlagDefinition }>();

const { t } = useI18n();
</script>

<template>
	<p v-if="definition.pluginPackageName" class="text-xs text-text-tertiary mt-1 font-mono">
		{{ t('components.settings.featureFlagMetadata.package', { name: definition.pluginPackageName }) }}
	</p>
	<p v-if="definition.requiredEnvVars?.length" class="text-xs text-text-tertiary mt-1 font-mono">
		{{
			t('components.settings.featureFlagMetadata.requiredEnv', {
				vars: definition.requiredEnvVars.join(', '),
			})
		}}
	</p>
	<p
		v-if="definition.requiredCapabilities?.length"
		class="text-xs text-text-tertiary mt-1 font-mono"
	>
		{{
			t('components.settings.featureFlagMetadata.requestedAccess', {
				capabilities: definition.requiredCapabilities.join(', '),
			})
		}}
	</p>
	<p v-if="definition.dockerProfiles?.length" class="text-xs text-text-tertiary mt-1 font-mono">
		{{
			t('components.settings.featureFlagMetadata.dockerProfile', {
				profiles: definition.dockerProfiles.join(', '),
			})
		}}
	</p>
</template>
