<script setup lang="ts">
/**
 * The collapsed Transport editor: which provider sends mail, by name, and on
 * the own server the offer to add a relay. The editor's "Change provider"
 * button is the one door for both.
 */
import { isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import { transportKindLabel } from '~/utils/transportState';

const props = defineProps<{
	/** The active `EMAIL_PROVIDER` kind, or null when none is set. */
	currentProvider: string | null;
}>();

const { t } = useI18n();

/**
 * The provider BY NAME ("Amazon SES", "Your own server"), never the raw
 * `EMAIL_PROVIDER` value — this card is the page's one "Change provider" door,
 * and it is read by people who have never seen the variable.
 */
const currentProviderName = computed(() =>
	props.currentProvider ? t(transportKindLabel(props.currentProvider)) : null
);
/** On the own server, the collapsed card also carries the offer to add a relay. */
const isOnOwnServer = computed(
	() => props.currentProvider === null || isOwnSendProviderKind(props.currentProvider)
);
</script>

<template>
	<div class="px-6 py-5">
		<I18nT
			keypath="components.delivery.transportEditor.activeTransport"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary"
		>
			<template #provider>
				<span class="font-medium text-text-primary" data-testid="transport-editor-provider">
					{{ currentProviderName ?? t('components.delivery.transportEditor.notSet') }}
				</span>
			</template>
		</I18nT>
		<!-- The one place to change the provider, so the offer to add a paid
		     provider next to the own server lives here too — not on a second
		     card with a second button that makes the same change. -->
		<p
			v-if="isOnOwnServer"
			class="text-sm text-text-secondary mt-2"
			data-testid="transport-editor-relay-offer"
		>
			{{ t('components.delivery.transportEditor.relayOffer') }}
		</p>
	</div>
</template>
