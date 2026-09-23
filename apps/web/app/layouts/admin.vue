<script setup lang="ts">
/**
 * The Workspace settings shell: the Settings sidebar over every admin page, and
 * the one page frame (`SettingsPageShell`) every settings page shares.
 *
 * Administration was hub-and-spoke: thirty-odd pages hung off three hub grids,
 * so Domains → Transport → Webhooks cost a trip back through the hub each time.
 * This layout reads the one admin table (`lib/adminSettingsRegistry`) for the
 * sidebar's Workspace tab, the palette provider below and the tab strip over
 * grouped pages ("Advanced" is one sidebar row with four tabs).
 *
 * Pages own their header (a verdict chip, a warm-up sentence, an actions row);
 * the shell owns the width, the padding and the title style, so moving between
 * neighbours no longer makes the content jump sideways.
 *
 * Nests inside `dashboard` so Settings keeps the app rail, header and ⌘K.
 */
import {
	ADMIN_ROOT,
	adminEntryFor,
	adminRailEntryFor,
	reachableAdminEntries,
	type AdminAreaKey,
} from '~/lib/adminSettingsRegistry';
import {
	ADMIN_COMMAND_PROVIDER_ID,
	ADMIN_COMMAND_PROVIDER_PRIORITY,
	adminTabsFor,
	buildAdminSurfaceGroups,
} from '~/lib/adminSettingsNav';
import { routePrefixMatcher } from '~/lib/commandPaletteRegistry';
import { settingsSectionsFor } from '~/lib/settingsRegistry';
import SettingsPageShell from '~/components/settings/PageShell.vue';
import { useWorkspaceSettingsNav } from '~/composables/useWorkspaceSettingsNav';

const { t } = useI18n();
const route = useRoute();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

const { environment, areas, badges } = useWorkspaceSettingsNav(ref(true));

// The personal half of Settings, behind the sidebar's "My settings" tab.
const { isDesktop } = useDesktopContext();
const youSections = computed(() =>
	settingsSectionsFor({ isFeatureEnabled, isDesktop: isDesktop.value })
);

/** The group the current page belongs to — what the compact row narrows to. */
const activeArea = computed<AdminAreaKey | null>(() => adminEntryFor(route.path)?.area ?? null);
/** The rail row standing for this page (its parent, for a hidden child). */
const railPath = computed(() => adminRailEntryFor(route.path)?.path ?? route.path);

/** Tables that need room opt out of the reading width. */
const wide = computed(() => adminEntryFor(route.path)?.wide === true);

/** Sibling pages shown as tabs (the "Advanced" delivery pages). */
const tabs = computed(() => adminTabsFor(route.path, environment.value));

/**
 * Below `lg` the sidebar becomes a scrollable pill row. It lists the CURRENT
 * group's pages rather than all thirty-odd — a phone-width strip of every admin
 * page is a scroll, not a navigation — plus the overview, which is the way back
 * to the other groups.
 *
 * On the overview that leaves one pill pointing at the page you are already on,
 * so the row hides itself there.
 */
const compactEntries = computed(() => {
	const overview = areas.value.find((area) => area.key === 'overview')?.entries ?? [];
	const current = areas.value.find((area) => area.key === activeArea.value)?.entries ?? [];
	return [...overview.filter((entry) => !current.includes(entry)), ...current];
});

// ⌘K, from inside Workspace settings: every admin destination this deployment
// has, above the core groups. The core navigation group caps at eight rows
// across the whole app, which is exactly where the sibling admin pages fall off.
registerCommandPaletteProvider({
	id: ADMIN_COMMAND_PROVIDER_ID,
	priority: ADMIN_COMMAND_PROVIDER_PRIORITY,
	matchRoute: routePrefixMatcher(ADMIN_ROOT),
	build: ({ query }) =>
		buildAdminSurfaceGroups(
			{
				entries: () => reachableAdminEntries(environment.value),
				t,
				areaTitleKey: (area) => `shell.admin.areas.${area}`,
				onOpen: (entry) => void navigateTo(entry.path),
			},
			query
		),
});
</script>

<template>
	<div>
		<!-- A native root keeps nested layout transitions from leaving the page blank. -->
		<NuxtLayout name="dashboard">
			<div class="flex w-full items-start">
				<!-- Settings takes the sidebar over on desktop. -->
				<DashboardNavigationPortal :title="t('components.shell.settings.title')">
					<div class="hidden lg:block w-56 shrink-0 self-start">
						<ShellSettingsNav :you-sections="youSections" :admin-areas="areas" :badges="badges" />
					</div>
				</DashboardNavigationPortal>

				<div class="min-w-0 flex-1">
					<!-- Same destinations, laid out for a narrow viewport. Both rails are in
					     the DOM at once (the swap is a media query, not a branch), so they
					     need DISTINGUISHABLE landmark names. -->
					<nav
						v-if="compactEntries.length > 1"
						class="lg:hidden flex gap-1.5 overflow-x-auto px-4 pt-6 sm:px-6 pb-1"
						:aria-label="t('shell.admin.navLabelCompact')"
					>
						<NuxtLink
							v-for="entry in compactEntries"
							:key="entry.path"
							:to="entry.path"
							class="shrink-0 rounded-full px-3 py-1 text-xs transition-colors duration-(--motion-fast)"
							:class="
								railPath === entry.path
									? 'bg-bg-surface font-medium text-text-primary'
									: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
							"
							:aria-current="railPath === entry.path ? 'page' : undefined"
						>
							{{ t(entry.titleKey) }}
						</NuxtLink>
					</nav>

					<SettingsPageShell :wide="wide">
						<template v-if="tabs.length > 0" #above>
							<nav
								class="mb-6 flex gap-1 overflow-x-auto border-b border-border-subtle"
								:aria-label="t('shell.admin.tabsLabel')"
							>
								<NuxtLink
									v-for="tab in tabs"
									:key="tab.path"
									:to="tab.path"
									class="-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors duration-(--motion-fast)"
									:class="
										route.path === tab.path
											? 'border-brand font-medium text-text-primary'
											: 'border-transparent text-text-secondary hover:text-text-primary'
									"
									:aria-current="route.path === tab.path ? 'page' : undefined"
								>
									{{ t(tab.titleKey) }}
								</NuxtLink>
							</nav>
						</template>
						<slot />
					</SettingsPageShell>
				</div>
			</div>
		</NuxtLayout>
	</div>
</template>
