<script setup lang="ts">
/**
 * The sender's address as a way out when the page itself cannot help: a
 * broken or expired link still leaves the recipient able to ask the sender
 * directly. Renders nothing when no address is known.
 */
defineProps<{ email: string | null; keypath: string }>();
</script>

<template>
	<I18nT
		v-if="email"
		:keypath="keypath"
		tag="p"
		scope="global"
		class="mt-4 text-sm break-words text-text-secondary"
	>
		<template #email>
			<a :href="`mailto:${email}`" class="font-medium text-brand underline underline-offset-2">{{
				email
			}}</a>
		</template>
	</I18nT>
</template>
