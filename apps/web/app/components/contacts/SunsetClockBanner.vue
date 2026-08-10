<script setup lang="ts">
/**
 * THE SUNSET CLOCK STALL — the one state of the auto-suppression engine that
 * needs a person.
 *
 * The hourly sweep refuses to run when this deployment's clock disagrees with
 * the heartbeat it stamped on an earlier tick (a jumped clock and a long pause
 * look identical from inside the sweep), and the sweep is the only writer of
 * that heartbeat — so the hold does NOT clear itself. Without this banner the
 * engine is silently off and the audit log is the only clue.
 *
 * IT RENDERS NOTHING WHEN THERE IS NOTHING TO SAY. A healthy deployment sees no
 * banner at all, so this is never a "setup incomplete" nag, and the query is
 * skipped entirely for viewers, who cannot clear the stall anyway — an error
 * card for a state they cannot act on would be worse than silence.
 *
 * SELF-CONTAINED ON PURPOSE. It owns its own query and mutation rather than
 * taking them as props: the suppression page has nothing else to do with the
 * sunset clock, and threading four bindings through it only to render one
 * conditional card is the coupling this extraction exists to remove.
 */
import { api } from '@owlat/api';

const { canManageContacts } = usePermissions();
const { showToast: showNotification } = useToast();

const { data: sunsetPolicies } = useOrganizationQuery(api.contacts.sunset.getSunsetPolicies, () =>
	canManageContacts.value ? {} : undefined
);
const isSweepStalled = computed(() => sunsetPolicies.value?.clock.isSweepStalled === true);

const { run: confirmSunsetClock, isLoading: isConfirming } = useBackendOperation(
	api.contacts.sunset.confirmSunsetClock,
	{ label: 'Confirm clock' }
);

const handleConfirmClock = async () => {
	const confirmedAt = await confirmSunsetClock({});
	if (confirmedAt === undefined) return;
	showNotification('Clock confirmed — the sunset sweep resumes on its next hourly tick');
};
</script>

<template>
	<!-- Calm, actionable, and only rendered while the stall lasts. -->
	<div v-if="isSweepStalled" class="card p-6 bg-warning/5 border-warning/20">
		<div class="flex gap-4">
			<UiIconBox icon="lucide:clock" size="sm" variant="warning" rounded="lg" />
			<div class="flex-1">
				<h3 class="font-medium text-text-primary mb-1">Automatic sunsetting is paused</h3>
				<p class="text-sm text-text-secondary">
					This deployment's clock disagrees with the timestamps it wrote earlier, so nobody is being
					auto-suppressed for inactivity. Nothing has changed and nothing will change until this
					clears. Check the server clock (NTP) — and if it is correct (a deployment that was simply
					paused for a long time looks the same from here), confirm it below to resume the hourly
					sweep.
				</p>
				<UiButton
					variant="secondary"
					size="sm"
					type="button"
					class="gap-2 mt-3"
					:disabled="isConfirming"
					@click="handleConfirmClock"
				>
					<Icon name="lucide:check" class="w-4 h-4" />
					{{ isConfirming ? 'Confirming…' : 'Confirm clock' }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
