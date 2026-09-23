<script setup lang="ts">
/**
 * The My settings shell: the Settings sidebar, one title, one page frame.
 *
 * There was no Preferences layout. Thirteen pages hand-rolled the same wrapper
 * (`p-6 lg:p-8`, a max width, `<PreferencesBackLink>`, an `<h1>`), the copies
 * had already drifted — two had lost the back link, the max width was spelled
 * three ways — and moving from Filters to Aliases meant going back to the hub
 * every time. This layout owns all of it, and the nav it renders is the same
 * `lib/settingsRegistry` table the sidebar, the breadcrumbs and the command
 * palette read, so a page can never appear in one and be missing from another.
 *
 * The title is the registry's, not the page's: the words in the crumb, in the
 * nav and above the page are one string. Pages keep their own intro paragraph
 * (several are richer than a registry line — links, inline code) and their own
 * actions, and start straight in on content.
 *
 * The frame itself (width, padding, title style) is `SettingsPageShell`, the
 * same one the Workspace pages sit in, so both halves of Settings line up.
 *
 * Nests inside `dashboard` so Preferences keeps the app rail, header, and ⌘K.
 */
import {
	settingsAnchorFromHash,
	settingsEntryFor,
	settingsSectionsFor,
} from '~/lib/settingsRegistry';
import SettingsPageShell from '~/components/settings/PageShell.vue';
import { useWorkspaceSettingsNav } from '~/composables/useWorkspaceSettingsNav';

const { t } = useI18n();
const route = useRoute();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { isDesktop } = useDesktopContext();

const sections = computed(() =>
	settingsSectionsFor({ isFeatureEnabled, isDesktop: isDesktop.value })
);

// Owners and admins get the Workspace tab of the same sidebar.
const { isAdmin } = usePermissions();
const { areas: adminAreas, badges } = useWorkspaceSettingsNav(isAdmin);

const activeEntry = computed(() => settingsEntryFor(route.path));
const heading = computed(() => (activeEntry.value ? t(activeEntry.value.titleKey) : ''));

/**
 * Palette deep links arrive as `path#anchor`. Nuxt does not scroll to a hash
 * that was already present when the page mounted, and the target may be several
 * screens down, so bring it into view ourselves — and flash it, because landing
 * silently in the middle of a long page reads as "this is the wrong page".
 */
const flashedAnchor = ref<string | null>(null);

function revealAnchor(hash: string) {
	const anchor = settingsAnchorFromHash(hash);
	if (!anchor) return;
	void nextTick(() => {
		const target = document.getElementById(anchor);
		if (!target) return;
		target.scrollIntoView({ behavior: 'smooth', block: 'start' });
		flashedAnchor.value = anchor;
		window.setTimeout(() => {
			if (flashedAnchor.value === anchor) flashedAnchor.value = null;
		}, 2000);
	});
}

onMounted(() => revealAnchor(route.hash));
watch(
	() => route.fullPath,
	() => revealAnchor(route.hash)
);
</script>

<template>
	<div>
		<!-- A native root keeps nested layout transitions from leaving the page blank. -->
		<NuxtLayout name="dashboard">
			<!-- Settings takes the sidebar over on desktop. -->
			<DashboardNavigationPortal :title="t('components.shell.settings.title')">
				<div class="hidden lg:block w-56 shrink-0 self-start">
					<ShellSettingsNav :you-sections="sections" :admin-areas="adminAreas" :badges="badges" />
				</div>
			</DashboardNavigationPortal>

			<SettingsPageShell>
				<!-- Below lg the sidebar becomes a scrollable pill row, so switching
				     pages still costs one tap. Both are in the DOM at once (the swap is
				     a media query, not a branch), so they need DISTINGUISHABLE landmark
				     names. -->
				<template #above>
					<nav
						class="lg:hidden -mx-1 mb-5 flex gap-1.5 overflow-x-auto pb-1"
						:aria-label="t('shell.preferences.navLabelCompact')"
					>
						<template v-for="section in sections" :key="section.key">
							<NuxtLink
								v-for="entry in section.entries"
								:key="entry.path"
								:to="entry.path"
								class="shrink-0 rounded-full border px-3 py-1 text-xs transition-colors duration-(--motion-fast)"
								:class="
									route.path === entry.path
										? 'border-brand bg-brand-subtle font-medium text-brand'
										: 'border-border-default text-text-secondary hover:text-text-primary'
								"
								:aria-current="route.path === entry.path ? 'page' : undefined"
							>
								{{ t(entry.titleKey) }}
							</NuxtLink>
						</template>
						<!-- The way over to the Workspace half, for owners and admins. -->
						<NuxtLink
							v-if="adminAreas.length > 0"
							to="/dashboard/admin"
							class="shrink-0 rounded-full border border-border-default px-3 py-1 text-xs text-text-secondary transition-colors duration-(--motion-fast) hover:text-text-primary"
						>
							{{ t('components.shell.settings.tabs.workspace') }}
						</NuxtLink>
					</nav>

					<h1 v-if="heading" class="mb-6 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ heading }}
					</h1>
				</template>

				<div :class="flashedAnchor ? 'settings-anchor-flash' : undefined">
					<slot />
				</div>
			</SettingsPageShell>
		</NuxtLayout>
	</div>
</template>

<style scoped>
/* The deep-linked section, briefly outlined. Scoped to a deep selector because
   the target lives inside the page rendered into the slot. */
.settings-anchor-flash :deep(:target) {
	outline: 2px solid var(--color-brand);
	outline-offset: 4px;
	border-radius: var(--radius-md, 0.5rem);
}
</style>
