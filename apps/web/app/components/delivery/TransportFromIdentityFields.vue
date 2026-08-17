<script setup lang="ts">
/**
 * The optional default From identity for a transport edit — the address and
 * display name outgoing mail falls back to when a send names none.
 *
 * Separate from {@link TransportCredentialFields} because it is not a
 * credential: nothing here is secret, none of it is per-vendor (every transport
 * asks the same two questions), and leaving both blank is a valid answer that
 * keeps whatever the deployment already uses. The editor still owns the values —
 * they are part of the env patch it applies — so the fields are models, and the
 * one rule that can fail (a malformed address) is decided by the shared
 * validator and passed back in as `error`.
 *
 * The i18n keys stay in the editor's namespace: this is that screen's copy,
 * moved into the component that renders it.
 */
defineProps<{
	/** The From-address error from the shared validator, or undefined. */
	error?: string;
}>();

const email = defineModel<string>('email', { required: true });
const name = defineModel<string>('name', { required: true });

const { t } = useI18n();
</script>

<template>
	<div class="border-t border-border-subtle pt-5">
		<h3 class="font-medium text-text-primary">
			{{ t('components.delivery.transportEditor.fromIdentity') }}
			<span class="text-sm font-normal text-text-tertiary">
				{{ t('components.delivery.transportEditor.optionalSuffix') }}
			</span>
		</h3>
		<p class="text-sm text-text-secondary mb-3">
			{{ t('components.delivery.transportEditor.fromIdentityHint') }}
		</p>
		<div class="space-y-4">
			<UiInput
				v-model="email"
				type="email"
				:label="t('components.delivery.transportEditor.fromEmailLabel')"
				:placeholder="t('components.delivery.transportEditor.fromEmailPlaceholder')"
				autocomplete="off"
				:error="error"
			/>
			<UiInput
				v-model="name"
				:label="t('components.delivery.transportEditor.fromNameLabel')"
				:placeholder="t('components.delivery.transportEditor.fromNamePlaceholder')"
				autocomplete="off"
			/>
		</div>
	</div>
</template>
