<script setup lang="ts">
/**
 * Alert sounds: one switch per alert the user can ask to hear (a reply on a
 * thread armed with "notify me when they reply", a conversation assigned to
 * them, an agent question waiting on them). All default off. The switches are
 * the person's own and live on the server, so they hold in every browser and
 * in the desktop app; `useAlertSounds` plays them.
 *
 * Only the alerts that can reach this person are listed: the reply alert
 * needs mail, assignments and agent questions need the team inbox and an
 * owner or admin role. The card hides itself when none can.
 *
 * Switching one on plays the chime once, from the click itself, so the user
 * hears what they chose and the browser lets later alerts play.
 */
import type { AlertSoundKind } from '~/lib/alertSoundRules';
import { ALERT_SOUND_KINDS } from '~/lib/alertSoundRules';
import { previewAlertSound } from '~/composables/postbox/useUiSound';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';

const KEY = 'components.postbox.postboxAlertSoundSettings';

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const { alertSounds, setAlertSound, isSaving, isLoading } = usePostboxSettings();

const hasMail = computed(() => isEnabled('postbox') || isEnabled('mail.external'));
const hasTeamAlerts = computed(() => isAdmin.value && isEnabled('inbox'));

const kinds = computed<AlertSoundKind[]>(() =>
	ALERT_SOUND_KINDS.filter((kind) => (kind === 'reply' ? hasMail.value : hasTeamAlerts.value))
);

function toggle(kind: AlertSoundKind, enabled: boolean): void {
	if (enabled) previewAlertSound();
	void setAlertSound(kind, enabled);
}
</script>

<template>
	<section
		v-if="kinds.length > 0"
		id="alert-sounds"
		class="card !p-0 mb-6 scroll-mt-6 overflow-hidden"
	>
		<header class="px-5 py-3 border-b border-border-subtle">
			<div class="flex items-center justify-between gap-3">
				<h2 class="font-semibold">{{ t(`${KEY}.heading`) }}</h2>
				<!-- The page around this card is about this device; these switches
				     are not, so the card says where they are kept. -->
				<UiBadge variant="neutral">{{ t(`${KEY}.scopeBadge`) }}</UiBadge>
			</div>
			<p class="text-xs text-text-tertiary mt-0.5">{{ t(`${KEY}.intro`) }}</p>
		</header>
		<div
			v-for="(kind, index) in kinds"
			:key="kind"
			class="px-5 py-4 flex items-center justify-between gap-4"
			:class="{ 'border-t border-border-subtle': index > 0 }"
		>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<label :for="`alert-sound-${kind}`" class="font-medium text-sm block">
						{{ t(`${KEY}.${kind}.label`) }}
					</label>
					<SettingsResetToDefault
						:changed="!isLoading && alertSounds[kind]"
						:label="t(`${KEY}.${kind}.label`)"
						:disabled="isSaving"
						@reset="setAlertSound(kind, false)"
					/>
				</div>
				<p class="text-xs text-text-tertiary mt-0.5">{{ t(`${KEY}.${kind}.hint`) }}</p>
			</div>
			<UiSwitch
				:id="`alert-sound-${kind}`"
				:model-value="alertSounds[kind]"
				:disabled="isSaving"
				@update:model-value="toggle(kind, $event)"
			/>
		</div>
	</section>
</template>
