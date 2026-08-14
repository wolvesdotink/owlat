<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * Ask-eagerness dial — the single "how readily should Owlat stop and ask me a
 * clarifying question" trust control, shown ALONGSIDE the Graduated Autonomy
 * rules so the two read as one coherent dial: autonomy decides when Owlat may
 * act without me, eagerness decides when it should ask me first.
 *
 * Absent setting = today's behaviour; the UI renders the neutral "Balanced"
 * position as the visual default without persisting anything until the owner
 * picks one.
 */

type EagernessMode = 'cautious' | 'balanced' | 'confident' | 'off';

const { t } = useI18n();

const { data: setting, isLoading } = useConvexQuery(
	api.inbox.askEagernessSettings.getAskEagerness,
	() => ({})
);

const { run: setEagerness } = useBackendOperation(api.inbox.askEagernessSettings.setAskEagerness, {
	label: () => t('components.autonomy.askEagernessDial.saveOperation'),
});

const { showToast } = useToast();

const options = computed<{ value: EagernessMode; label: string; hint: string }[]>(() => [
	{
		value: 'cautious',
		label: t('components.autonomy.askEagernessDial.options.cautious.label'),
		hint: t('components.autonomy.askEagernessDial.options.cautious.hint'),
	},
	{
		value: 'balanced',
		label: t('components.autonomy.askEagernessDial.options.balanced.label'),
		hint: t('components.autonomy.askEagernessDial.options.balanced.hint'),
	},
	{
		value: 'confident',
		label: t('components.autonomy.askEagernessDial.options.confident.label'),
		hint: t('components.autonomy.askEagernessDial.options.confident.hint'),
	},
	{
		value: 'off',
		label: t('components.autonomy.askEagernessDial.options.off.label'),
		hint: t('components.autonomy.askEagernessDial.options.off.hint'),
	},
]);

// The persisted mode, defaulting the DISPLAY to Balanced when unset (null).
const selected = computed<EagernessMode>(() => setting.value?.mode ?? 'balanced');

const isSaving = ref(false);

async function choose(mode: EagernessMode) {
	if (isSaving.value || mode === setting.value?.mode) return;
	isSaving.value = true;
	try {
		await setEagerness({ mode });
		showToast(t('components.autonomy.askEagernessDial.updatedToast'));
	} finally {
		isSaving.value = false;
	}
}
</script>

<template>
	<UiCard>
		<div class="flex items-center gap-3 mb-2">
			<UiIconBox icon="lucide:help-circle" size="sm" variant="surface" />
			<h3 class="text-base font-medium text-text-primary">
				{{ t('components.autonomy.askEagernessDial.title') }}
			</h3>
		</div>
		<p class="text-sm text-text-secondary mb-4">
			{{ t('components.autonomy.askEagernessDial.body') }}
		</p>

		<div v-if="isLoading" class="flex justify-center py-4">
			<UiSpinner />
		</div>

		<div
			v-else
			class="space-y-2"
			role="radiogroup"
			:aria-label="t('components.autonomy.askEagernessDial.title')"
		>
			<button
				v-for="opt in options"
				:key="opt.value"
				type="button"
				role="radio"
				:aria-checked="selected === opt.value"
				:disabled="isSaving"
				class="w-full text-left rounded-lg border px-3 py-2.5 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:class="
					selected === opt.value
						? 'border-brand bg-brand-subtle'
						: 'border-border-default hover:border-border-strong'
				"
				@click="choose(opt.value)"
			>
				<div class="flex items-center justify-between gap-3">
					<span class="text-sm font-medium text-text-primary">{{ opt.label }}</span>
					<Icon
						v-if="selected === opt.value"
						name="lucide:check"
						class="w-4 h-4 text-brand shrink-0"
					/>
				</div>
				<span class="text-xs text-text-tertiary">{{ opt.hint }}</span>
			</button>
		</div>
	</UiCard>
</template>
