<script setup lang="ts">
/**
 * The Preferences shell: a persistent left nav, one title, one padding.
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
 * Nests inside `dashboard` so Preferences keeps the app rail, header, and ⌘K.
 */
import {
	settingsAnchorFromHash,
	settingsEntryFor,
	settingsSectionsFor,
} from '~/lib/settingsRegistry';

const { t } = useI18n();
const route = useRoute();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { isDesktop } = useDesktopContext();

const sections = computed(() =>
	settingsSectionsFor({ isFeatureEnabled, isDesktop: isDesktop.value })
);

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
	<NuxtLayout name="dashboard">
		<div class="p-6 lg:p-8">
			<div class="mx-auto flex w-full max-w-5xl gap-8">
				<!-- Persistent left nav. Sticky so a long page never strands you. -->
				<nav
					class="hidden lg:block w-56 shrink-0 self-start sticky top-6"
					:aria-label="t('shell.preferences.navLabel')"
				>
					<p class="px-3 mb-3 text-xs font-medium uppercase tracking-wider text-text-tertiary">
						{{ t('shell.preferences.title') }}
					</p>
					<div v-for="section in sections" :key="section.key" class="mb-4">
						<p class="px-3 mb-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary">
							{{ t(section.titleKey) }}
						</p>
						<ul>
							<li v-for="entry in section.entries" :key="entry.path">
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
					<!-- Below lg the rail becomes a scrollable pill row, so switching
					     pages still costs one tap instead of a trip back to the hub. -->
					<nav
						class="lg:hidden -mx-1 mb-5 flex gap-1.5 overflow-x-auto pb-1"
						:aria-label="t('shell.preferences.navLabel')"
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
					</nav>

					<h1 v-if="heading" class="mb-6 text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ heading }}
					</h1>

					<div :class="flashedAnchor ? 'settings-anchor-flash' : undefined">
						<slot />
					</div>
				</div>
			</div>
		</div>
	</NuxtLayout>
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
