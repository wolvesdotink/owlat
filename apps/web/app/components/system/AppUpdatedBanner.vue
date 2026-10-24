<script setup lang="ts">
/**
 * "Owlat was updated": shown once the server runs a newer build than this
 * tab (see `lib/appVersion.ts`). Reload waits until nothing would be lost;
 * when something still would, it says so and leaves the page alone. Mounted
 * once, from app.vue, on app pages.
 */
import { useAppVersionWatch } from '~/composables/useAppVersionWatch';
import { releaseNotesUrl } from '~/lib/appVersion';

const { t } = useI18n();
const versionWatch = useAppVersionWatch();

const dismissed = ref(false);
const status = ref<'idle' | 'reloading' | 'blocked'>('idle');

const update = computed(() => versionWatch?.update.value ?? null);
const notesUrl = computed(() => releaseNotesUrl(update.value?.version ?? null));

let stop: (() => void) | undefined;
onMounted(() => {
	stop = versionWatch?.start();
});
onBeforeUnmount(() => stop?.());

async function reload(): Promise<void> {
	if (!versionWatch || status.value === 'reloading') return;
	status.value = 'reloading';
	const outcome = await versionWatch.reloadNow();
	status.value = outcome;
}

function dismiss(): void {
	dismissed.value = true;
}
</script>

<template>
	<!-- Always rendered, so screen readers hear the notice when it appears.
	     Bottom centre: the sidebar and the undo toasts hold the bottom-left
	     corner, the toast stack the bottom-right. Under the sidebar and every
	     dialog (--z-float), so an open drawer or modal is never covered. -->
	<div
		aria-live="polite"
		class="pointer-events-none fixed bottom-[max(calc(var(--ui-bottom-chrome-height,0px)+0.5rem),calc(1.5rem+env(safe-area-inset-bottom,0px)))] left-[calc(1rem+env(safe-area-inset-left,0px))] right-[calc(1rem+env(safe-area-inset-right,0px))] z-(--z-float) flex justify-center"
	>
		<section
			v-if="update && !dismissed"
			data-testid="app-updated-banner"
			:aria-label="t('shared.appUpdated.title')"
			class="pointer-events-auto flex w-full min-w-0 items-start gap-3 rounded-xl border border-border-default bg-bg-elevated px-4 py-3 shadow-lg sm:w-[22rem]"
		>
			<div
				class="flex size-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-soft"
				aria-hidden="true"
			>
				<Icon name="lucide:sparkles" size="16" class="text-brand" />
			</div>
			<div class="min-w-0 flex-1 space-y-1">
				<p class="text-sm font-medium text-text-primary">
					{{ t('shared.appUpdated.title') }}
				</p>
				<p class="text-sm text-text-secondary">
					{{
						update.version
							? t('shared.appUpdated.bodyVersion', { version: update.version })
							: t('shared.appUpdated.body')
					}}
				</p>
				<p
					v-if="status === 'blocked'"
					class="text-sm text-warning"
					data-testid="app-updated-blocked"
				>
					{{ t('shared.appUpdated.blocked') }}
				</p>
				<div class="flex flex-wrap items-center gap-2 pt-1">
					<UiButton size="sm" :loading="status === 'reloading'" @click="reload">
						{{
							status === 'reloading'
								? t('shared.appUpdated.reloading')
								: t('shared.appUpdated.reload')
						}}
					</UiButton>
					<UiButton
						v-if="notesUrl"
						size="sm"
						variant="ghost"
						:href="notesUrl"
						target="_blank"
						rel="noopener noreferrer"
					>
						{{ t('shared.appUpdated.whatsNew') }}
						<span class="sr-only">{{ t('shared.appUpdated.opensInNewTab') }}</span>
					</UiButton>
				</div>
			</div>
			<button
				type="button"
				class="flex-shrink-0 rounded-lg p-1 text-text-tertiary transition-colors hover:bg-bg-surface-hover hover:text-text-primary"
				:aria-label="t('shared.appUpdated.dismiss')"
				@click="dismiss"
			>
				<Icon name="lucide:x" size="16" aria-hidden="true" />
			</button>
		</section>
	</div>
</template>
