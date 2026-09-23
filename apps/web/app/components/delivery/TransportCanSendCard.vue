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
 *
 * The remedy is the shared `DeliveryEnvSetupSteps` block, so this card says
 * the same thing every other Delivery page says when it needs a variable, and
 * it asks the page to re-read the status while it waits. Once the server
 * reports the variables present the card flips to "can send" and says
 * "Connected" — but only if this visit started out waiting, so a healthy
 * deployment is not congratulated on every page load.
 */
import DeliveryEnvSetupSteps from './EnvSetupSteps.vue';

const props = defineProps<{
	canSend: boolean;
	/** Missing variable names, in the order to show them. Empty hides the remedy. */
	missingEnv: readonly string[];
}>();

const emit = defineEmits<{ refresh: [] }>();

const { t } = useI18n();

const wasWaiting = ref(!props.canSend && props.missingEnv.length > 0);
watch(
	() => !props.canSend && props.missingEnv.length > 0,
	(waiting) => {
		if (waiting) wasWaiting.value = true;
	}
);
const showConnected = computed(() => props.canSend && wasWaiting.value);
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-6 flex items-start gap-4" :class="canSend ? 'bg-success/5' : 'bg-error/5'">
			<div
				class="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
				:class="canSend ? 'bg-success/15 text-success' : 'bg-error/15 text-error'"
			>
				<Icon :name="canSend ? 'lucide:check-circle-2' : 'lucide:alert-triangle'" class="w-6 h-6" />
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
					{{
						canSend
							? t('dashboard.admin.delivery.transport.canSend.yesBody')
							: t('dashboard.admin.delivery.transport.canSend.noBody')
					}}
				</p>

				<!-- Actionable remedy: paste-ready .env lines + the owlat commands for
				     the MISSING vars, then a live "Connected" once the server sees them.
				     Names only — no secret value is ever rendered. -->
				<DeliveryEnvSetupSteps
					v-if="(!canSend && missingEnv.length > 0) || showConnected"
					class="mt-4"
					:variables="missingEnv"
					:connected="canSend"
					:connected-label="t('dashboard.admin.delivery.transport.canSend.connected')"
					@refresh="emit('refresh')"
				/>
			</div>
		</div>
	</UiCard>
</template>
