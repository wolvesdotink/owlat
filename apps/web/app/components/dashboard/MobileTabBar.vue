<script setup lang="ts">
/**
 * The phone's bottom bar: Home, Mail, create, People, More.
 *
 * Before this, the entire mobile chrome was a hamburger, a logo and a search
 * icon — every destination and every create started by opening the drawer and
 * reading a menu. The five slots are the ones the drawer's own navigation core
 * puts first, and the centre one is the same quick-create registry the header
 * split button uses, so the phone offers the same verbs as the desktop under
 * the same permission and flag gates.
 *
 * It hides while anything else owns the bottom of the screen — a composer, a
 * dialog, its own create sheet, a page's rail drawer, or the navigation drawer
 * it opens: a fixed bar over a sheet is a tap target the person cannot see they
 * are hitting, and at z-(--z-header) the bar outranks every one of those
 * overlays, so "stays visible" reads as "paints over them".
 *
 * The slot you are on is marked by weight and primary text, the way the desktop
 * rail marks its active row — a permanently terracotta tab would spend the one
 * accent a screen gets on chrome rather than on the page's own content.
 *
 * Teleported to `body` so no ancestor's transform or overflow can capture the
 * fixed positioning, and inset-aware so the home indicator never sits on top of
 * the create button.
 */
const props = defineProps<{
	/** The shell's off-canvas navigation drawer — z-50, i.e. under this bar. */
	navigationOpen?: boolean;
}>();

const emit = defineEmits<{ openNavigation: [] }>();

const { t } = useI18n();
const route = useRoute();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const { actions } = useQuickCreateMenu();
const { activeComposerId } = usePostboxComposerStack();
// A page's conversation rail (UiRailDrawer) while it is off-canvas-open. Not a
// prop like `navigationOpen`, because that drawer belongs to the page rather
// than to the shell that mounts this bar.
const { isOpen: isRailDrawerOpen } = useRailDrawer();

const isSheetOpen = ref(false);

interface TabItem {
	id: string;
	href: string;
	icon: string;
	label: string;
}

/**
 * Mail goes wherever this instance's mail actually lives: the personal Postbox
 * when it is on, the shared team inbox otherwise, and the slot disappears
 * entirely on an instance with neither rather than linking to a 404.
 */
const mailTab = computed<TabItem | null>(() => {
	const href =
		isFeatureEnabled('postbox') || isFeatureEnabled('mail.external')
			? '/dashboard/postbox/inbox'
			: isFeatureEnabled('inbox')
				? '/dashboard/inbox'
				: null;
	if (!href) return null;
	return {
		id: 'mail',
		href,
		icon: 'lucide:mailbox',
		label: t('components.dashboard.mobileTabBar.mail'),
	};
});

/** The slots left of the create button. */
const leadingTabs = computed<TabItem[]>(() => {
	const tabs: TabItem[] = [
		{
			id: 'home',
			href: '/dashboard',
			icon: 'lucide:layout-dashboard',
			label: t('components.dashboard.mobileTabBar.home'),
		},
	];
	if (mailTab.value) tabs.push(mailTab.value);
	return tabs;
});

/** The slots right of it — "More" is a button, so it is not in this list. */
const trailingTabs = computed<TabItem[]>(() => [
	{
		id: 'people',
		href: '/dashboard/audience/contacts',
		icon: 'lucide:users',
		label: t('components.dashboard.mobileTabBar.people'),
	},
]);

/** Same rule the rail uses: the overview matches exactly, sections by prefix. */
function isActive(href: string): boolean {
	return href === '/dashboard' ? route.path === href : route.path.startsWith(href);
}

/**
 * Is a dialog on screen? Watched rather than asked once, because the bar
 * outlives every overlay the app opens and no single component owns them all.
 * `aria-modal` is the one marker every dialog in the app carries (UiModal sets
 * it), which makes this true for a dialog nobody has thought of yet.
 */
const hasDialog = ref(false);

onMounted(() => {
	const sync = () => {
		hasDialog.value = document.querySelector('[aria-modal="true"]') !== null;
	};
	sync();
	const observer = new MutationObserver(sync);
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['aria-modal'],
	});
	onUnmounted(() => observer.disconnect());
});

/**
 * `isSheetOpen` is checked as well as `hasDialog` so the bar leaves on the tap
 * that opens the sheet rather than one MutationObserver task later.
 */
const isVisible = computed(
	() =>
		activeComposerId.value === null &&
		!hasDialog.value &&
		!isSheetOpen.value &&
		!isRailDrawerOpen.value &&
		!props.navigationOpen
);

function run(action: (typeof actions.value)[number]): void {
	isSheetOpen.value = false;
	action.run();
}
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="transition-transform duration-(--motion-moderate) ease-spring"
			enter-from-class="translate-y-full"
			enter-to-class="translate-y-0"
			leave-active-class="transition-transform duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="translate-y-0"
			leave-to-class="translate-y-full"
		>
			<nav
				v-if="isVisible"
				class="lg:hidden fixed bottom-0 inset-x-0 z-(--z-header) bg-bg-elevated border-t border-border-subtle pb-[env(safe-area-inset-bottom)]"
				:aria-label="t('components.dashboard.mobileTabBar.label')"
				data-testid="mobile-tab-bar"
			>
				<ul class="h-16 flex items-stretch">
					<li v-for="tab in leadingTabs" :key="tab.id" class="flex-1">
						<NuxtLink
							:to="tab.href"
							class="h-full flex flex-col items-center justify-center gap-1 text-2xs transition-colors duration-(--motion-fast)"
							:class="isActive(tab.href) ? 'text-text-primary font-medium' : 'text-text-tertiary'"
							:aria-current="isActive(tab.href) ? 'page' : undefined"
						>
							<Icon :name="tab.icon" class="w-5 h-5" />
							{{ tab.label }}
						</NuxtLink>
					</li>

					<li v-if="actions.length > 0" class="flex items-center justify-center px-2">
						<UiButton
							aria-haspopup="dialog"
							:aria-expanded="isSheetOpen"
							:aria-label="t('components.dashboard.mobileTabBar.create')"
							data-testid="mobile-tab-bar-create"
							@click="isSheetOpen = true"
						>
							<Icon name="lucide:plus" class="w-5 h-5" />
						</UiButton>
					</li>

					<li v-for="tab in trailingTabs" :key="tab.id" class="flex-1">
						<NuxtLink
							:to="tab.href"
							class="h-full flex flex-col items-center justify-center gap-1 text-2xs transition-colors duration-(--motion-fast)"
							:class="isActive(tab.href) ? 'text-text-primary font-medium' : 'text-text-tertiary'"
							:aria-current="isActive(tab.href) ? 'page' : undefined"
						>
							<Icon :name="tab.icon" class="w-5 h-5" />
							{{ tab.label }}
						</NuxtLink>
					</li>

					<li class="flex-1">
						<button
							type="button"
							class="w-full h-full flex flex-col items-center justify-center gap-1 text-2xs text-text-tertiary transition-colors duration-(--motion-fast) hover:text-text-primary"
							data-testid="mobile-tab-bar-more"
							@click="emit('openNavigation')"
						>
							<Icon name="lucide:menu" class="w-5 h-5" />
							{{ t('components.dashboard.mobileTabBar.more') }}
						</button>
					</li>
				</ul>
			</nav>
		</Transition>
	</Teleport>

	<!-- The same verbs as the header menu, as the sheet a thumb can reach. -->
	<UiModal
		:open="isSheetOpen"
		:title="t('components.dashboard.mobileTabBar.create')"
		size="sm"
		@update:open="isSheetOpen = $event"
	>
		<ul class="-m-2 space-y-1">
			<li v-for="action in actions" :key="action.id">
				<button
					type="button"
					class="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-text-primary transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover"
					@click="run(action)"
				>
					<Icon :name="action.icon" class="w-5 h-5 text-text-tertiary" />
					{{ action.label }}
				</button>
			</li>
		</ul>
	</UiModal>
</template>

<style>
/*
 * Reserve the bar's height at the bottom of the page it floats over. A fixed
 * bar cannot push content, and `#main-content` is the dashboard layout's one
 * scrolling region — without this the last row of every list on a phone sits
 * under the create button. Desktop (where the bar is not rendered) is untouched.
 *
 * 1023px mirrors Tailwind's `lg` (1024px), the same breakpoint the shell
 * switches its chrome on and the `lg:hidden` above hides this bar at.
 */
@media (max-width: 1023px) {
	#main-content {
		padding-bottom: calc(4rem + env(safe-area-inset-bottom, 0px));
	}
}
</style>
