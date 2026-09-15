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
import { formatDateTime, formatRelativeTime } from '~/utils/formatters';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.desktopUpdates.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

const { canManageSettings } = usePermissions();
const { showToast } = useToast();

const { policy, releases, isLoading, error, savePolicy, isSaving, checkNow, isChecking } =
	useDesktopUpdatePolicy();

type Mode = 'latest' | 'pinned' | 'paused';
type Channel = 'stable' | 'prerelease';

/** Mirrors `MAX_DEFER_HOURS` in the resolver; the backend rejects anything above. */
const MAX_DEFER_HOURS = 168;

const MODES: Mode[] = ['latest', 'pinned', 'paused'];
const CHANNELS: Channel[] = ['stable', 'prerelease'];

const form = reactive({
	mode: 'latest' as Mode,
	channel: 'stable' as Channel,
	pinnedVersion: '',
	deferHours: 0,
});

// The stored policy is the authority; the form is a working copy of it, re-seeded
// whenever the subscription re-emits (another admin saving, or our own write
// landing).
watch(
	policy,
	(value) => {
		const stored = value?.policy;
		if (!stored) return;
		form.mode = stored.mode;
		form.channel = stored.channel;
		form.pinnedVersion = stored.pinnedVersion ?? '';
		form.deferHours = stored.deferHours ?? 0;
	},
	{ immediate: true }
);

const cachedReleases = computed(() => releases.value ?? []);

/**
 * What the pin picker may offer: cached releases only, on the channel the form
 * is currently set to. Saving a pin the cache has never seen is refused server
 * side, so the picker is the UI half of the same rule rather than a hint.
 */
const pinnableReleases = computed(() =>
	cachedReleases.value.filter(
		(release) => !release.isPrerelease || form.channel === 'prerelease'
	)
);

/** `listReleases` hands back newest-first, so the head of the filtered list is it. */
const newestRelease = computed(() => pinnableReleases.value[0] ?? null);

const checkedAt = computed(() => policy.value?.check.checkedAt ?? null);
const checkError = computed(() => policy.value?.check.error ?? null);
const lastChange = computed(() => policy.value?.lastChange ?? null);

function lineLabel(line: string): string {
	return t(
		line === 'desktop'
			? 'dashboard.admin.instance.desktopUpdates.lines.desktop'
			: 'dashboard.admin.instance.desktopUpdates.lines.unified'
	);
}

const deferError = computed(() => {
	const hours = form.deferHours;
	if (Number.isInteger(hours) && hours >= 0 && hours <= MAX_DEFER_HOURS) return '';
	return t('dashboard.admin.instance.desktopUpdates.defer.invalid', { max: MAX_DEFER_HOURS });
});

const isDirty = computed(() => {
	const stored = policy.value?.policy;
	if (!stored) return false;
	return (
		form.mode !== stored.mode ||
		form.channel !== stored.channel ||
		form.deferHours !== (stored.deferHours ?? 0) ||
		(form.mode === 'pinned' && form.pinnedVersion !== (stored.pinnedVersion ?? ''))
	);
});

const canSave = computed(
	() =>
		canManageSettings.value &&
		isDirty.value &&
		!deferError.value &&
		(form.mode !== 'pinned' || form.pinnedVersion !== '')
);

async function save() {
	if (!canSave.value) return;
	// `requiredVersion` has no control yet (the blocking prompt is a later
	// change), and `updatePolicy` REPLACES the whole object — so carry the stored
	// value through rather than clearing a floor nobody asked us to clear.
	const stored = policy.value?.policy;
	const result = await savePolicy({
		mode: form.mode,
		channel: form.channel,
		pinnedVersion: form.mode === 'pinned' ? form.pinnedVersion : undefined,
		requiredVersion: stored?.requiredVersion ?? undefined,
		deferHours: form.deferHours > 0 ? form.deferHours : undefined,
	});
	if (!result.ok) return;
	showToast(t('dashboard.admin.instance.desktopUpdates.savedToast'));
}

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
	<div class="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
		<div>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.instance.desktopUpdates.title') }}
			</h1>
			<p class="mt-1 text-text-secondary">
				{{ t('dashboard.admin.instance.desktopUpdates.intro') }}
			</p>
		</div>

		<UiQueryBoundary :loading="isLoading && !policy" :error="error">
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
						{{
							t('dashboard.admin.instance.desktopUpdates.lastCheckError', { error: checkError })
						}}
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
								:key="release.version"
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
						<p v-if="deferError" class="text-xs text-error" data-testid="desktop-updates-defer-error">
							{{ deferError }}
						</p>
						<p v-else class="text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.desktopUpdates.defer.help', { max: MAX_DEFER_HOURS }) }}
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
							@click="save"
						>
							{{ t('dashboard.admin.instance.desktopUpdates.save') }}
						</UiButton>
					</div>
				</section>

				<!-- Cached releases, newest first, with the GitHub body behind a
				     disclosure — the same shape the system page uses for its notes. -->
				<section class="card p-5">
					<h2 class="text-base font-semibold text-text-primary">
						{{ t('dashboard.admin.instance.desktopUpdates.releases.title') }}
					</h2>

					<UiEmptyState
						v-if="cachedReleases.length === 0"
						class="mt-2"
						icon="lucide:monitor-down"
						:title="t('dashboard.admin.instance.desktopUpdates.empty.title')"
						:description="t('dashboard.admin.instance.desktopUpdates.empty.description')"
						data-testid="desktop-updates-empty"
					>
						<UiButton
							variant="outline"
							size="sm"
							:loading="isChecking"
							:disabled="!canManageSettings"
							data-testid="desktop-updates-empty-check"
							@click="runCheck"
						>
							{{ t('dashboard.admin.instance.desktopUpdates.checkNow') }}
						</UiButton>
					</UiEmptyState>

					<table v-else class="mt-3 w-full text-sm" data-testid="desktop-updates-releases">
						<thead>
							<tr class="text-left text-xs uppercase tracking-wider text-text-tertiary">
								<th class="py-2 font-medium">
									{{ t('dashboard.admin.instance.desktopUpdates.releases.version') }}
								</th>
								<th class="py-2 font-medium">
									{{ t('dashboard.admin.instance.desktopUpdates.releases.line') }}
								</th>
								<th class="py-2 font-medium">
									{{ t('dashboard.admin.instance.desktopUpdates.releases.published') }}
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="release in cachedReleases"
								:key="release.version"
								class="border-t border-border-subtle align-top"
								:data-testid="`desktop-updates-release-${release.version}`"
							>
								<td class="py-2 font-mono text-text-primary">
									{{ release.version }}
									<span v-if="release.isPrerelease" class="ml-1 text-xs text-text-tertiary">
										{{ t('dashboard.admin.instance.desktopUpdates.releases.prerelease') }}
									</span>
								</td>
								<td class="py-2 text-text-secondary">{{ lineLabel(release.line) }}</td>
								<td class="py-2 text-text-secondary">
									{{ formatDateTime(release.publishedAt) }}
									<details v-if="release.notes" class="mt-1">
										<summary
											class="text-xs font-medium text-text-primary cursor-pointer hover:text-brand"
										>
											{{ t('dashboard.admin.instance.desktopUpdates.releases.notes') }}
										</summary>
										<pre
											class="mt-2 text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed"
											>{{ release.notes }}</pre
										>
									</details>
								</td>
							</tr>
						</tbody>
					</table>
				</section>
			</div>
		</UiQueryBoundary>
	</div>
</template>
