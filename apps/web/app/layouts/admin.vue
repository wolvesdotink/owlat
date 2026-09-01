<script setup lang="ts">
/**
 * The Administration shell: a persistent left rail over every admin page.
 *
 * Administration was hub-and-spoke. Thirty-odd pages hung off three hub grids in
 * the plain `dashboard` layout, so Domains → Transport → Webhooks cost a trip
 * back through the hub each time, and the four ramp pages were folded into a
 * collapsed disclosure on the Delivery hub — in no rail, no hub grid and no ⌘K.
 * This layout gives the area the rail Preferences has had since the settings
 * registry landed, reading the same one table (`lib/adminSettingsRegistry`) the
 * palette provider below reads.
 *
 * Unlike `preferences`, it renders NO page title and NO padding of its own: the
 * admin pages each own a real header (a verdict chip, a warm-up sentence, an
 * operating-mode picker) and their own `p-6 lg:p-8` wrapper. The layout adds the
 * rail and nothing else, so the hubs keep their card grids untouched.
 *
 * Nests inside `dashboard` so Administration keeps the app rail, header and ⌘K.
 */
import { api } from '@owlat/api';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import {
	ADMIN_COMMAND_PROVIDER_ID,
	ADMIN_COMMAND_PROVIDER_PRIORITY,
	ADMIN_ROOT,
	adminAreasFor,
	adminEntryFor,
	buildAdminSurfaceGroups,
	reachableAdminEntries,
	type AdminAreaKey,
	type AdminEnvironment,
} from '~/lib/adminSettingsRegistry';
import { routePrefixMatcher } from '~/lib/commandPaletteRegistry';

const { t } = useI18n();
const route = useRoute();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// Deployment-level tooling is scoped to this deployment's platform admin — the
// same gate the admin hub puts on its Platform card grid, and the same gate the
// three pages carry as `platform-admin` route middleware.
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => ({})
);

const environment = computed<AdminEnvironment>(() => ({
	isFeatureEnabled,
	isPlatformAdmin: isPlatformAdmin.value === true,
	hasPlugins: bundledPluginComposition.length > 0,
}));

const areas = computed(() => adminAreasFor(environment.value));

/** The area the current page belongs to — what the compact row narrows to. */
const activeArea = computed<AdminAreaKey | null>(() => adminEntryFor(route.path)?.area ?? null);

/**
 * Below `lg` the rail becomes a scrollable pill row. It lists the CURRENT area's
 * pages rather than all thirty-odd — a phone-width strip of every admin page is
 * a scroll, not a navigation — plus Administration itself, which is the way back
 * to the other areas' hubs.
 *
 * On the Administration hub that leaves one pill pointing at the page you are
 * already on, so the row hides itself there: the hub's own card grid is the
 * navigation at that width.
 */
const compactEntries = computed(() => {
	const overview = areas.value.find((area) => area.key === 'overview')?.entries ?? [];
	const current = areas.value.find((area) => area.key === activeArea.value)?.entries ?? [];
	return [...overview.filter((entry) => !current.includes(entry)), ...current];
});

// ⌘K, from inside Administration: every admin destination this deployment has,
// above the core groups. The core navigation group caps at eight rows across the
// whole app, which is exactly where the sibling admin pages fall off.
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
	<NuxtLayout name="dashboard">
		<div class="flex w-full items-start">
			<!-- Persistent left rail: present on every admin page, scrolled by the
			     PAGE rather than by itself. The tree is thirty-odd rows — taller than
			     a laptop viewport — so the inner `max-h`/`overflow-y-auto` it used to
			     carry ended it at Channels behind an invisible edge (no scrollbar, no
			     fade): Team & access and Platform read as absent, and their pages had
			     no active entry anywhere on screen. Pinning it instead (`sticky`)
			     would hide exactly the same tail on any page long enough to scroll.
			     Full height, no inner scroller: every entry is reachable. -->
			<nav
				class="hidden lg:block w-56 shrink-0 self-start py-8 pl-6"
				:aria-label="t('shell.admin.navLabel')"
			>
				<!-- No standalone rail title: the first area's eyebrow already says
				     Administration, and the crumb above the page says it again. -->
				<div v-for="area in areas" :key="area.key" class="mb-4">
					<p class="px-3 mb-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary">
						{{ t(area.titleKey) }}
					</p>
					<ul>
						<li v-for="entry in area.entries" :key="entry.path">
							<NuxtLink
								:to="entry.path"
								class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors duration-(--motion-fast)"
								:class="
									route.path === entry.path
										? 'bg-bg-surface font-medium text-text-primary'
										: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
								"
								:aria-current="route.path === entry.path ? 'page' : undefined"
							>
								<Icon :name="entry.icon" class="size-4 shrink-0" />
								<span class="truncate">{{ t(entry.titleKey) }}</span>
							</NuxtLink>
						</li>
					</ul>
				</div>
			</nav>

			<div class="min-w-0 flex-1">
				<!-- Same destinations, laid out for a narrow viewport. Both rails are in
				     the DOM at once (the swap is a media query, not a branch), so they
				     need DISTINGUISHABLE landmark names — two `<nav>`s answering to
				     "Administration sections" is a landmark list a screen-reader user
				     cannot choose from. -->
				<nav
					v-if="compactEntries.length > 1"
					class="lg:hidden flex gap-1.5 overflow-x-auto px-6 pt-6 pb-1"
					:aria-label="t('shell.admin.navLabelCompact')"
				>
					<NuxtLink
						v-for="entry in compactEntries"
						:key="entry.path"
						:to="entry.path"
						class="shrink-0 rounded-full px-3 py-1 text-xs transition-colors duration-(--motion-fast)"
						:class="
							route.path === entry.path
								? 'bg-bg-surface font-medium text-text-primary'
								: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
						"
						:aria-current="route.path === entry.path ? 'page' : undefined"
					>
						{{ t(entry.titleKey) }}
					</NuxtLink>
				</nav>

				<slot />
			</div>
		</div>
	</NuxtLayout>
</template>
