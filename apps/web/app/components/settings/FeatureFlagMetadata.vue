<script setup lang="ts">
import type { FeatureFlagDefinition } from '@owlat/shared/featureFlags';

defineProps<{ definition: FeatureFlagDefinition }>();
</script>

<template>
	<p v-if="definition.pluginPackageName" class="text-xs text-text-tertiary mt-1 font-mono">
		Package: {{ definition.pluginPackageName }}
	</p>
	<p v-if="definition.requiredEnvVars?.length" class="text-xs text-text-tertiary mt-1 font-mono">
		Requires env: {{ definition.requiredEnvVars.join(', ') }}
	</p>
	<p
		v-if="definition.requiredCapabilities?.length"
		class="text-xs text-text-tertiary mt-1 font-mono"
	>
		Requests access: {{ definition.requiredCapabilities.join(', ') }}
	</p>
	<p v-if="definition.dockerProfiles?.length" class="text-xs text-text-tertiary mt-1 font-mono">
		Docker profile: {{ definition.dockerProfiles.join(', ') }}
	</p>
</template>
