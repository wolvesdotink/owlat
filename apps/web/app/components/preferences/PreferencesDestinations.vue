<script setup lang="ts">
/**
 * The Preferences hub's destination grid, read off `lib/settingsRegistry`.
 *
 * Replaces `PreferencesMailLinks.vue`, a hand-written grid of nine cards that
 * had to be edited whenever a page was added — and that the hub rendered behind
 * `v-if="hasMail"`, so on an instance with no mail every one of its
 * destinations (aliases, vacation, snippets, writing voice, app passwords) had
 * no entry point at all. Here the registry's own gates decide what appears, one
 * card per reachable entry, grouped by the registry's sections.
 *
 * The hub itself is skipped: it is the page you are standing on.
 */
import { settingsSectionsFor, SETTINGS_ROOT } from '~/lib/settingsRegistry';

const { t } = useI18n();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { isDesktop } = useDesktopContext();

const sections = computed(() =>
	settingsSectionsFor({ isFeatureEnabled, isDesktop: isDesktop.value })
		.map((section) => ({
			...section,
			entries: section.entries.filter((entry) => entry.path !== SETTINGS_ROOT),
		}))
		.filter((section) => section.entries.length > 0)
);
</script>

<template>
	<nav
		v-if="sections.length > 0"
		class="mb-8"
		:aria-label="t('components.preferences.preferencesDestinations.ariaLabel')"
	>
		<div v-for="section in sections" :key="section.key" class="mb-5 last:mb-0">
			<h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-text-tertiary">
				{{ t(section.titleKey) }}
			</h2>
			<div class="grid gap-3 sm:grid-cols-2">
				<NuxtLink
					v-for="entry in section.entries"
					:key="entry.path"
					:to="entry.path"
					class="card !p-4 flex items-center gap-3 hover:bg-bg-surface"
				>
					<Icon :name="entry.icon" class="size-5 shrink-0 text-text-secondary" />
					<span class="min-w-0">
						<span class="block text-sm font-medium">{{ t(entry.titleKey) }}</span>
						<span class="block text-xs text-text-tertiary">{{ t(entry.descriptionKey) }}</span>
					</span>
				</NuxtLink>
			</div>
		</div>
	</nav>
</template>
