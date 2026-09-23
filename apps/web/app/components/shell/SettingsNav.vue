<script setup lang="ts">
import type { SettingsSectionView } from '~/lib/settingsRegistry';
import type { AdminAreaView } from '~/lib/adminSettingsRegistry';

/**
 * One Settings navigation for both halves of what used to be two sidebar
 * sections: "You" (Preferences — account, mail, device) and, for owners and
 * admins, "Workspace" (Administration — delivery, instance, team, …). It takes
 * the sidebar over while you are in Settings, like a separate mode, with its
 * own search and a way back to where you were.
 *
 * Both registries stay the single source of truth; this only renders them.
 */
const props = defineProps<{
	youSections: readonly SettingsSectionView[];
	adminAreas: readonly AdminAreaView[];
}>();

const { t } = useI18n();
const route = useRoute();
const returnTo = useState<string | null>('settings-return-to', () => null);

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

function isCurrent(path: string): boolean {
	return route.path === path;
}
function leaveSettings() {
	void navigateTo(returnTo.value ?? '/dashboard');
}
function openFirstResult() {
	const first = results.value[0];
	if (first) void navigateTo(first.path);
}
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

		<template v-else>
			<nav :aria-label="t('shell.preferences.navLabel')">
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

			<p
				v-if="adminAreas.length > 0"
				class="mx-3 border-t border-border-subtle pt-3 text-2xs font-semibold text-text-secondary"
			>
				{{ t('components.shell.settings.workspace') }}
			</p>
			<nav v-if="adminAreas.length > 0" :aria-label="t('shell.admin.navLabel')">
				<div v-for="area in adminAreas" :key="area.key" class="mb-3">
					<p class="px-3 pb-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary">
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
							</NuxtLink>
						</li>
					</ul>
				</div>
			</nav>
		</template>
	</div>
</template>
