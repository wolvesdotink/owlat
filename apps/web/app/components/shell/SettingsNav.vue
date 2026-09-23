<script setup lang="ts">
import type { SettingsSectionView } from '~/lib/settingsRegistry';
import { adminRailEntryFor, type AdminAreaView } from '~/lib/adminSettingsRegistry';

/**
 * The Settings sidebar. It takes the sidebar over while you are in Settings,
 * like a separate mode, with its own search and a way back to where you were.
 *
 * Two tabs split it the way people think about it: "My settings" (your
 * account, your mail, this device) and, for owners and admins, "Workspace"
 * (team, email delivery, AI, features, system). One long column of both put
 * the workspace half below the fold. The tab follows the page you are on and
 * can be switched to browse the other half without leaving it; search always
 * covers both.
 *
 * Both registries stay the single source of truth; this only renders them.
 */
const props = defineProps<{
	youSections: readonly SettingsSectionView[];
	adminAreas: readonly AdminAreaView[];
	/** Attention counts by entry path (quarantine, failed messages). */
	badges?: Readonly<Record<string, number>>;
}>();

const { t } = useI18n();
const route = useRoute();
const returnTo = useState<string | null>('settings-return-to', () => null);

type SettingsTab = 'mine' | 'workspace';
const hasWorkspace = computed(() => props.adminAreas.length > 0);
const tabForRoute = (): SettingsTab =>
	hasWorkspace.value && route.path.startsWith('/dashboard/admin') ? 'workspace' : 'mine';
const activeTab = ref<SettingsTab>(tabForRoute());
watch(
	() => [route.path, hasWorkspace.value] as const,
	() => {
		activeTab.value = tabForRoute();
	}
);

/** Anything waiting on the Workspace side, for the dot on its tab. */
const workspaceNeedsAttention = computed(() =>
	Object.values(props.badges ?? {}).some((count) => count > 0)
);

const query = ref('');
const normalized = computed(() => query.value.trim().toLowerCase());
const results = computed(() => {
	if (!normalized.value) return [];
	const all = [
		...props.youSections.flatMap((s) =>
			s.entries.map((e) => ({
				path: e.path,
				icon: e.icon,
				title: t(e.titleKey),
				group: t(s.titleKey),
			}))
		),
		...props.adminAreas.flatMap((a) =>
			a.entries.map((e) => ({
				path: e.path,
				icon: e.icon,
				title: t(e.titleKey),
				group: t(a.titleKey),
			}))
		),
	];
	return all.filter(
		(r) =>
			r.title.toLowerCase().includes(normalized.value) ||
			r.group.toLowerCase().includes(normalized.value)
	);
});

/** The rail row that stands for this page — its parent for a hidden child page. */
const currentRailPath = computed(() => adminRailEntryFor(route.path)?.path ?? route.path);
function isCurrent(path: string): boolean {
	return currentRailPath.value === path;
}
function badgeFor(path: string): number {
	return props.badges?.[path] ?? 0;
}
function leaveSettings() {
	void navigateTo(returnTo.value ?? '/dashboard');
}
function openFirstResult() {
	const first = results.value[0];
	if (first) void navigateTo(first.path);
}

const tabs = computed(() => [
	{ key: 'mine' as const, label: t('components.shell.settings.tabs.mine') },
	...(hasWorkspace.value
		? [{ key: 'workspace' as const, label: t('components.shell.settings.tabs.workspace') }]
		: []),
]);
</script>

<template>
	<div class="flex flex-col gap-3">
		<div class="flex items-center justify-between px-3">
			<p class="text-sm font-medium text-text-primary">
				{{ t('components.shell.settings.title') }}
			</p>
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-surface hover:text-text-primary"
				@click="leaveSettings"
			>
				<Icon name="lucide:arrow-left" class="size-3" />
				{{ t('components.shell.settings.back') }}
			</button>
		</div>

		<!-- My settings / Workspace. Only an admin has the second half, so a
		     member sees no switch at all. -->
		<div
			v-if="tabs.length > 1"
			class="mx-2 flex gap-1 rounded-lg bg-bg-surface p-0.5"
			role="group"
			:aria-label="t('components.shell.settings.tabsLabel')"
		>
			<button
				v-for="tab in tabs"
				:key="tab.key"
				type="button"
				class="relative flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors duration-(--motion-fast)"
				:class="
					activeTab === tab.key
						? 'bg-bg-elevated text-text-primary shadow-sm'
						: 'text-text-secondary hover:text-text-primary'
				"
				:aria-pressed="activeTab === tab.key"
				@click="activeTab = tab.key"
			>
				{{ tab.label }}
				<template
					v-if="tab.key === 'workspace' && workspaceNeedsAttention && activeTab !== 'workspace'"
				>
					<span
						class="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-error"
						aria-hidden="true"
					/>
					<span class="sr-only">{{ t('components.shell.settings.needsAttention') }}</span>
				</template>
			</button>
		</div>

		<label
			class="mx-2 flex items-center gap-2 rounded-lg bg-bg-surface px-2.5 py-1.5 text-xs text-text-tertiary focus-within:ring-2 focus-within:ring-brand"
		>
			<Icon name="lucide:search" class="size-3.5" />
			<input
				v-model="query"
				type="search"
				class="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary"
				:placeholder="t('components.shell.settings.search')"
				:aria-label="t('components.shell.settings.search')"
				@keydown.enter.prevent="openFirstResult"
			/>
		</label>

		<ul v-if="normalized" class="px-1" :aria-label="t('components.shell.settings.results')">
			<li v-for="result in results" :key="result.path">
				<NuxtLink
					:to="result.path"
					class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-surface hover:text-text-primary"
				>
					<Icon :name="result.icon" class="size-4 shrink-0" />
					<span class="truncate">{{ result.title }}</span>
					<span class="ml-auto truncate text-2xs text-text-tertiary">{{ result.group }}</span>
				</NuxtLink>
			</li>
			<li v-if="results.length === 0" class="px-3 py-2 text-xs text-text-tertiary">
				{{ t('components.shell.settings.noResults') }}
			</li>
		</ul>

		<nav v-else-if="activeTab === 'mine'" :aria-label="t('shell.preferences.navLabel')">
			<div v-for="section in youSections" :key="section.key" class="mb-3">
				<p class="px-3 pb-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary">
					{{ t(section.titleKey) }}
				</p>
				<ul>
					<li v-for="entry in section.entries" :key="entry.path">
						<NuxtLink
							:to="entry.path"
							class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors duration-(--motion-fast)"
							:class="
								isCurrent(entry.path)
									? 'bg-bg-surface font-medium text-text-primary'
									: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
							"
							:aria-current="isCurrent(entry.path) ? 'page' : undefined"
						>
							<Icon :name="entry.icon" class="size-4 shrink-0" />
							<span class="truncate">{{ t(entry.titleKey) }}</span>
						</NuxtLink>
					</li>
				</ul>
			</div>
		</nav>

		<nav v-else :aria-label="t('shell.admin.navLabel')">
			<div v-for="area in adminAreas" :key="area.key" class="mb-3">
				<!-- The overview leads the tab on its own; it is not a group. -->
				<p
					v-if="area.key !== 'overview'"
					class="px-3 pb-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
				>
					{{ t(area.titleKey) }}
				</p>
				<ul>
					<li v-for="entry in area.entries" :key="entry.path">
						<NuxtLink
							:to="entry.path"
							class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors duration-(--motion-fast)"
							:class="
								isCurrent(entry.path)
									? 'bg-bg-surface font-medium text-text-primary'
									: 'text-text-secondary hover:bg-bg-surface hover:text-text-primary'
							"
							:aria-current="isCurrent(entry.path) ? 'page' : undefined"
						>
							<Icon :name="entry.icon" class="size-4 shrink-0" />
							<span class="truncate">{{ t(entry.titleKey) }}</span>
							<template v-if="badgeFor(entry.path) > 0">
								<span
									class="ml-auto rounded-full bg-error-subtle px-1.5 text-2xs font-medium tabular-nums text-error"
									aria-hidden="true"
								>
									{{ badgeFor(entry.path) }}
								</span>
								<span class="sr-only">
									{{ t('components.shell.settings.waitingCount', { count: badgeFor(entry.path) }) }}
								</span>
							</template>
						</NuxtLink>
					</li>
				</ul>
			</div>
		</nav>
	</div>
</template>
