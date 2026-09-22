<script setup lang="ts">
/**
 * A CONSEQUENCE-NAMING CONFIRMATION.
 *
 * Two actions in this product can lose reputation that took weeks to build:
 * forcing a share past the evidence, and disconnecting the relay a cell is still
 * leaning on. Neither may be reachable from a single click, so both come through
 * here — and "cannot fire from a single click" is enforced by the shape of the
 * component rather than by a habit: the confirm button is disabled until the
 * exact phrase has been typed.
 *
 * THE PHRASE IS NOT WHAT MAKES EITHER ACTION SAFE — THE SERVER CHECK IS. Both
 * constants live in `@owlat/shared/deliverabilityIndependence` and both are
 * re-checked where the change actually happens: `FORCE_ADVANCE_CONFIRMATION` by
 * `delivery.rampControls.forceAdvanceCellShare`, and `RELAY_REMOVAL_CONFIRMATION`
 * by `POST /api/delivery/apply-transport` (which is where a transport is
 * repointed, from the editor AND from the connection wizard). Anything that
 * reaches either of THOSE meets the same rule without rendering this dialog; a
 * dialog with no server check behind it is decoration, and this component may
 * not be used that way.
 *
 * THAT IS A CLAIM ABOUT TWO ENTRY POINTS, NOT ABOUT EVERY WAY TO LOSE THE ARM.
 * The reference arm is whatever `configuredRelayKinds` finds, and it reads the
 * ENABLED `providerRoutes` rows as well as `EMAIL_PROVIDER` — so unchecking the
 * last enabled relay route on the provider-routing screen removes the arm
 * exactly as switching `EMAIL_PROVIDER` to `mta` does, through
 * `providerRoutes.setRoute`, which asks for nothing. That surface is open: it is
 * a routing editor rather than a transport change, and gating it belongs with a
 * consequence read of its own rather than with a phrase bolted onto a checkbox.
 *
 * `aria-modal` IS A PROMISE ABOUT THE KEYBOARD, so this component keeps it:
 * focus moves into the phrase input on open, Tab cycles inside the dialog rather
 * than wandering into the page behind it, Escape cancels, and focus returns to
 * whatever opened it. A destructive confirmation a keyboard user can tab out of
 * without noticing is not a confirmation.
 *
 * IT NAMES THE CONSEQUENCE, NOT THE RISK IN GENERAL. The `consequence` slot is
 * required to say what specifically happens to this deployment — which cells,
 * how much traffic, and what date it would be safe instead. "This may affect
 * deliverability" is the sentence this component exists to prevent.
 */
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';
import { isConfirmationPhraseMatch } from '@owlat/shared/deliverabilityIndependence';

const props = defineProps<{
	open: boolean;
	title: string;
	/** The exact words the operator must type. Shared with the server check. */
	phrase: string;
	confirmLabel: string;
	busy?: boolean;
}>();

const emit = defineEmits<{ confirm: [phrase: string]; cancel: [] }>();

const { t } = useI18n();

const typed = ref('');
const headingId = useId();
const descriptionId = useId();
const inputId = useId();
const dialogEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
useModalFocus(
	dialogEl,
	() => props.open,
	() => {
		if (!props.busy) emit('cancel');
	}
);

const canConfirm = computed(
	() => props.busy !== true && isConfirmationPhraseMatch(typed.value, props.phrase)
);

watch(
	() => props.open,
	(open) => {
		if (!open) typed.value = '';
	}
);

function confirm(): void {
	if (!canConfirm.value) return;
	emit('confirm', typed.value);
}
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
		data-testid="ramp-confirm-dialog"
	>
		<div
			ref="dialogEl"
			tabindex="-1"
			role="dialog"
			aria-modal="true"
			:aria-labelledby="headingId"
			:aria-describedby="descriptionId"
			class="w-full max-w-lg space-y-4 rounded-xl bg-bg-surface p-6 shadow-lg"
		>
			<h2 :id="headingId" class="text-lg font-semibold text-text-primary">{{ title }}</h2>

			<div :id="descriptionId" class="space-y-2 text-sm text-text-secondary">
				<slot name="consequence" />
			</div>

			<div class="space-y-1">
				<label :for="inputId" class="block text-sm text-text-primary">
					<I18nT
						keypath="components.delivery.rampConfirmDialog.typeToConfirm"
						tag="span"
						scope="global"
					>
						<template #phrase>
							<span class="font-mono font-semibold">{{ phrase }}</span>
						</template>
					</I18nT>
				</label>
				<input
					:id="inputId"
					ref="inputEl"
					v-model="typed"
					type="text"
					autocomplete="off"
					spellcheck="false"
					class="input input-sm"
					data-testid="ramp-confirm-input"
					@keydown.enter.prevent="confirm"
				/>
			</div>

			<div class="flex justify-end gap-2">
				<UiButton
					variant="ghost"
					size="sm"
					data-testid="ramp-confirm-cancel"
					@click="emit('cancel')"
				>
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					variant="primary"
					size="sm"
					:disabled="!canConfirm"
					data-testid="ramp-confirm-submit"
					@click="confirm"
				>
					{{ confirmLabel }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
