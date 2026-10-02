<script setup lang="ts">
/**
 * Desktop app updates — the instance-wide policy for what connected Owlat
 * desktop apps are offered when they ask this instance which version to install.
 *
 * The app used to read one hard-coded GitHub URL, so an operator could neither
 * hold a bad build back nor reach the desktop-only release line. The server now
 * decides, and this is where that decision is made: serve the newest release,
 * pin the fleet to one, or serve nothing at all, on the stable or the
 * pre-release channel, optionally after a defer window.
 *
 * What the server can do is bounded by design and the page says so: bundles
 * still come from GitHub and are still verified against the key baked into the
 * app, so a policy can withhold a release but never substitute one, and a pin
 * never rolls a client backwards.
 *
 * Reads go through `useDesktopUpdatePolicy` (the same seam the device page's
 * "managed by your admin" line uses). The backend floor for both writes is
 * `settings:manage`, mirrored here by disabling the controls — the `admin`
 * route guard already keeps non-admins off the page, so this is the second
 * lock rather than the only one.
 */
import { UnsavedChangesDialog } from '@owlat/email-builder';
import DesktopReleaseTable from '~/components/settings/DesktopReleaseTable.vue';
import { useSettingsForm } from '~/composables/useSettingsForm';
import { formatDateTime, formatRelativeTime } from '~/utils/formatters';
import { releaseLineKey } from '~/composables/useDesktopUpdatePolicy';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.desktopUpdates.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const { canManageSettings } = usePermissions();
const { showToast } = useToast();

const { policy, releases, isLoading, error, refetch, savePolicy, checkNow, isChecking } =
	useDesktopUpdatePolicy();

type Mode = 'latest' | 'pinned' | 'paused';
type Channel = 'stable' | 'prerelease';

/** Mirrors `MAX_DEFER_HOURS` in the resolver; the backend rejects anything above. */
const MAX_DEFER_HOURS = 168;

const MODES: Mode[] = ['latest', 'pinned', 'paused'];
const CHANNELS: Channel[] = ['stable', 'prerelease'];

type PolicyForm = {
	mode: Mode;
	channel: Channel;
	pinnedVersion: string;
	deferHours: number;
};

const DEFAULTS: PolicyForm = {
	mode: 'latest',
	channel: 'stable',
	pinnedVersion: '',
	deferHours: 0,
};

const storedPolicy = computed(() => policy.value?.policy ?? undefined);

const deferInvalid = (hours: number) =>
	!(Number.isInteger(hours) && hours >= 0 && hours <= MAX_DEFER_HOURS);

/** A policy the backend accepts from this member: a valid window, and a pin when pinned. */
const isSavable = (draft: PolicyForm) =>
	canManageSettings.value &&
	!deferInvalid(draft.deferHours) &&
	(draft.mode !== 'pinned' || draft.pinnedVersion !== '');

// The stored policy is the authority; the form is a working copy of it. Another
// admin saving (or our own write landing) re-emits it, which replaces the copy
// only while it holds no unsaved change.
const { form, isDirty, isSaving, handleSave, unsavedDialog } = useSettingsForm({
	source: storedPolicy,
	defaults: DEFAULTS,
	project: (stored) => ({
		mode: stored.mode,
		channel: stored.channel,
		pinnedVersion: stored.pinnedVersion ?? '',
		deferHours: stored.deferHours ?? 0,
	}),
	// The pin only means something in pinned mode: a pin left over from an
	// earlier pinned policy, or dropped by the channel watch below, is no change.
	dirtyKey: (draft) => ({
		mode: draft.mode,
		channel: draft.channel,
		deferHours: draft.deferHours,
		pinnedVersion: draft.mode === 'pinned' ? draft.pinnedVersion : '',
	}),
	validate: isSavable,
	save: async (draft) => {
		// `requiredVersion` has no control yet (the blocking prompt is a later
		// change), and `updatePolicy` REPLACES the whole object — so carry the
		// stored value through rather than clearing a floor nobody asked us to clear.
		const result = await savePolicy({
			mode: draft.mode,
			channel: draft.channel,
			pinnedVersion: draft.mode === 'pinned' ? draft.pinnedVersion : undefined,
			requiredVersion: storedPolicy.value?.requiredVersion ?? undefined,
			deferHours: draft.deferHours > 0 ? draft.deferHours : undefined,
		});
		if (!result.ok) return false;
		showToast(t('dashboard.admin.instance.desktopUpdates.savedToast'));
		return true;
	},
});

const cachedReleases = computed(() => releases.value ?? []);

/**
 * What the pin picker may offer: cached releases only, on the channel the form
 * is currently set to. Saving a pin the cache has never seen is refused server
 * side, so the picker is the UI half of the same rule rather than a hint.
 */
const pinnableReleases = computed(() =>
	cachedReleases.value.filter((release) => !release.isPrerelease || form.channel === 'prerelease')
);

/** `listReleases` hands back newest-first, so the head of the filtered list is it. */
const newestRelease = computed(() => pinnableReleases.value[0] ?? null);

// Switching the channel can hide the release the pin points at (an rc pinned on
// `prerelease`, then `stable` chosen). The picker would show blank while the
// stale value was still submitted — and the backend refuses that combination —
// so drop the pin as soon as the channel can no longer see it.
watch(pinnableReleases, (offered) => {
	if (
		form.pinnedVersion !== '' &&
		!offered.some((release) => release.version === form.pinnedVersion)
	) {
		form.pinnedVersion = '';
	}
});

/** The saved pin when the cache no longer holds it: clients are then offered nothing. */
const missingPin = computed(() =>
	policy.value?.pinCached === false ? (storedPolicy.value?.pinnedVersion ?? null) : null
);

const checkedAt = computed(() => policy.value?.check.checkedAt ?? null);
const checkError = computed(() => policy.value?.check.error ?? null);
const lastChange = computed(() => policy.value?.lastChange ?? null);

const lineLabel = (line: string) => t(releaseLineKey(line));

const deferError = computed(() =>
	deferInvalid(form.deferHours)
		? t('dashboard.admin.instance.desktopUpdates.defer.invalid', { max: MAX_DEFER_HOURS })
		: ''
);

const canSave = computed(() => isDirty.value && isSavable(form));

async function runCheck() {
	const result = await checkNow({});
	if (!result.ok) return;
	if (result.result.error) {
		showToast(
			t('dashboard.admin.instance.desktopUpdates.lastCheckError', {
				error: result.result.error,
			}),
			'error'
		);
		return;
	}
	showToast(t('dashboard.admin.instance.desktopUpdates.checkedToast'));
}
</script>

<template>
	<div class="space-y-6">
		<UiPageHeader
			:title="t('dashboard.admin.instance.desktopUpdates.title')"
			:description="t('dashboard.admin.instance.desktopUpdates.intro')"
		/>

		<UiQueryBoundary :loading="isLoading && !policy" :error="error" @retry="refetch">
			<div class="space-y-6">
				<!-- Newest cached release + the poll that fills the cache -->
				<section class="card p-5">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0">
							<h2 class="text-sm font-medium text-text-tertiary uppercase tracking-wider">
								{{ t('dashboard.admin.instance.desktopUpdates.newest.label') }}
							</h2>
							<p
								v-if="newestRelease"
								class="mt-1 text-lg font-semibold text-text-primary"
								data-testid="desktop-updates-newest"
							>
								{{ newestRelease.version }}
							</p>
							<p v-else class="mt-1 text-text-primary" data-testid="desktop-updates-newest">
								{{ t('dashboard.admin.instance.desktopUpdates.newest.none') }}
							</p>
							<p class="mt-1 text-xs text-text-tertiary">
								<template v-if="newestRelease">
									{{ lineLabel(newestRelease.line) }} ·
									{{
										t('dashboard.admin.instance.desktopUpdates.newest.published', {
											date: formatRelativeTime(newestRelease.publishedAt),
										})
									}}
									·
								</template>
								{{
									checkedAt
										? t('dashboard.admin.instance.desktopUpdates.newest.checked', {
												date: formatRelativeTime(checkedAt),
											})
										: t('dashboard.admin.instance.desktopUpdates.newest.neverChecked')
								}}
							</p>
						</div>

						<UiButton
							variant="outline"
							size="sm"
							:loading="isChecking"
							:disabled="!canManageSettings"
							data-testid="desktop-updates-check-now"
							@click="runCheck"
						>
							{{ t('dashboard.admin.instance.desktopUpdates.checkNow') }}
						</UiButton>
					</div>

					<p
						v-if="checkError"
						class="mt-3 text-xs text-warning"
						data-testid="desktop-updates-check-error"
					>
						{{ t('dashboard.admin.instance.desktopUpdates.lastCheckError', { error: checkError }) }}
					</p>
				</section>

				<p v-if="!canManageSettings" class="text-sm text-text-secondary">
					{{ t('dashboard.admin.instance.desktopUpdates.readOnly') }}
				</p>

				<!-- The policy itself -->
				<section class="card p-5 space-y-6">
					<fieldset class="space-y-2.5">
						<legend class="text-sm font-medium text-text-primary mb-2">
							{{ t('dashboard.admin.instance.desktopUpdates.modes.label') }}
						</legend>
						<label
							v-for="mode in MODES"
							:key="mode"
							class="flex items-start gap-3 rounded-(--radius-card) border p-4 transition-colors"
							:class="[
								form.mode === mode
									? 'border-brand bg-brand/5'
									: 'border-transparent shadow-surface-1',
								canManageSettings ? 'cursor-pointer hover:bg-bg-elevated' : 'opacity-70',
							]"
						>
							<input
								v-model="form.mode"
								type="radio"
								name="desktop-update-mode"
								class="mt-1 accent-brand"
								:value="mode"
								:disabled="!canManageSettings || isSaving"
								:data-testid="`desktop-updates-mode-${mode}`"
							/>
							<span class="min-w-0">
								<span class="block text-sm font-medium text-text-primary">
									{{ t(`dashboard.admin.instance.desktopUpdates.modes.${mode}.title`) }}
								</span>
								<span class="mt-0.5 block text-xs text-text-secondary">
									{{ t(`dashboard.admin.instance.desktopUpdates.modes.${mode}.description`) }}
								</span>
							</span>
						</label>
					</fieldset>

					<!-- Pin picker: cached releases only, so the UI cannot get ahead of
					     the cache the backend validates against. -->
					<div v-if="form.mode === 'pinned'" class="space-y-2">
						<label for="desktop-update-pin" class="block text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.instance.desktopUpdates.pin.label') }}
						</label>
						<select
							id="desktop-update-pin"
							v-model="form.pinnedVersion"
							class="input"
							:disabled="!canManageSettings || isSaving"
							data-testid="desktop-updates-pin"
						>
							<option value="">
								{{ t('dashboard.admin.instance.desktopUpdates.pin.placeholder') }}
							</option>
							<option
								v-for="release in pinnableReleases"
								:key="release.tag"
								:value="release.version"
							>
								{{ release.version }} · {{ lineLabel(release.line) }} ·
								{{ formatDateTime(release.publishedAt) }}
							</option>
						</select>
						<p
							v-if="pinnableReleases.length === 0"
							class="text-xs text-warning"
							data-testid="desktop-updates-pin-empty"
						>
							{{ t('dashboard.admin.instance.desktopUpdates.pin.noneCached') }}
						</p>
						<p
							v-if="missingPin"
							class="text-xs text-warning"
							data-testid="desktop-updates-pin-missing"
						>
							{{
								t('dashboard.admin.instance.desktopUpdates.pin.missing', { version: missingPin })
							}}
						</p>
					</div>

					<fieldset class="space-y-2.5">
						<legend class="text-sm font-medium text-text-primary mb-2">
							{{ t('dashboard.admin.instance.desktopUpdates.channel.label') }}
						</legend>
						<label
							v-for="channel in CHANNELS"
							:key="channel"
							class="flex items-center gap-3 text-sm text-text-primary"
							:class="canManageSettings ? 'cursor-pointer' : 'opacity-70'"
						>
							<input
								v-model="form.channel"
								type="radio"
								name="desktop-update-channel"
								class="accent-brand"
								:value="channel"
								:disabled="!canManageSettings || isSaving"
								:data-testid="`desktop-updates-channel-${channel}`"
							/>
							{{ t(`dashboard.admin.instance.desktopUpdates.channel.${channel}`) }}
						</label>
					</fieldset>

					<div class="space-y-2">
						<label for="desktop-update-defer" class="block text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.instance.desktopUpdates.defer.label') }}
						</label>
						<div class="flex items-center gap-2">
							<input
								id="desktop-update-defer"
								v-model.number="form.deferHours"
								type="number"
								min="0"
								:max="MAX_DEFER_HOURS"
								step="1"
								class="input input-sm w-28"
								:disabled="!canManageSettings || isSaving"
								data-testid="desktop-updates-defer"
							/>
							<span class="text-sm text-text-secondary">
								{{ t('dashboard.admin.instance.desktopUpdates.defer.suffix') }}
							</span>
						</div>
						<p
							v-if="deferError"
							class="text-xs text-error"
							data-testid="desktop-updates-defer-error"
						>
							{{ deferError }}
						</p>
						<p v-else class="text-xs text-text-tertiary">
							{{
								t('dashboard.admin.instance.desktopUpdates.defer.help', { max: MAX_DEFER_HOURS })
							}}
						</p>
					</div>

					<div
						class="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4"
					>
						<p class="text-xs text-text-tertiary" data-testid="desktop-updates-audit">
							<template v-if="lastChange && lastChange.by">
								{{
									t('dashboard.admin.instance.desktopUpdates.auditLine', {
										who: lastChange.by,
										date: formatDateTime(lastChange.at),
									})
								}}
							</template>
							<template v-else-if="lastChange">
								{{
									t('dashboard.admin.instance.desktopUpdates.auditLineUnknown', {
										date: formatDateTime(lastChange.at),
									})
								}}
							</template>
							<template v-else>
								{{ t('dashboard.admin.instance.desktopUpdates.auditNever') }}
							</template>
						</p>
						<UiButton
							:loading="isSaving"
							:disabled="!canSave"
							data-testid="desktop-updates-save"
							@click="handleSave"
						>
							{{ t('dashboard.admin.instance.desktopUpdates.save') }}
						</UiButton>
					</div>
				</section>

				<DesktopReleaseTable
					:releases="cachedReleases"
					:checking="isChecking"
					:can-manage="canManageSettings"
					@check="runCheck"
				/>
			</div>
		</UiQueryBoundary>

		<UnsavedChangesDialog
			:show="unsavedDialog.showDialog"
			:saving="unsavedDialog.isSavingBeforeLeave"
			@close="unsavedDialog.cancelNavigation"
			@discard="unsavedDialog.confirmDiscard"
			@save="unsavedDialog.confirmSave"
		/>
	</div>
</template>
