/**
 * How the dashboard rail is laid out: collapsed to its icon strip or not, its
 * width, the gutter the content keeps for it, and how it slides when hidden.
 */
import type { Ref } from 'vue';
import { useMediaQuery } from '~/composables/useMediaQuery';

export function useShellSidebarLayout(options: {
	/** The saved collapse preference, resolved for the viewport. */
	preferredCollapsed: Readonly<Ref<boolean>>;
	toggleCollapsed: () => void;
	effectiveHidden: Readonly<Ref<boolean>>;
	isPeeking: Readonly<Ref<boolean>>;
	/** The section lending its navigation to the rail, if any. */
	activeSection: Readonly<Ref<unknown>>;
}) {
	const { preferredCollapsed, toggleCollapsed, effectiveHidden, isPeeking, activeSection } =
		options;
	const { t } = useI18n();
	const route = useRoute();

	// The Postbox brings its own folder rail beside the list, and next to it the
	// full sidebar is a second copy of the same inboxes. There the sidebar folds to
	// its icon rail on its own (desktop only; below lg it is the drawer), until it
	// is opened again, which holds for the session.
	const isDesktopViewport = useMediaQuery('(min-width: 1024px)');
	const foldsOnItsOwn = computed(
		() => isDesktopViewport.value && route.path.startsWith('/dashboard/postbox')
	);
	const openedOnPostbox = useState('sidebar-opened-on-postbox', () => false);
	const isCollapsed = computed(() => {
		if (activeSection.value) return false;
		return preferredCollapsed.value || (foldsOnItsOwn.value && !openedOnPostbox.value);
	});
	function onToggleCollapse() {
		if (!foldsOnItsOwn.value) return toggleCollapsed();
		const opening = isCollapsed.value;
		// Opening there also clears a saved "collapsed", so the rail actually opens.
		if (opening && preferredCollapsed.value) toggleCollapsed();
		openedOnPostbox.value = opening;
	}

	// The collapse control's one label.
	const sidebarToggleLabel = computed(() => {
		return isCollapsed.value
			? t('shell.dashboard.expandSidebar')
			: t('shell.dashboard.collapseSidebar');
	});

	// Computed sidebar width class — a hidden sidebar peeks at its last width.
	// Collapse swaps the width in one frame: animating `width` here (and the
	// content padding below) relaid the whole app out on every frame of the move.
	const sidebarWidthClass = computed(() => {
		return isCollapsed.value ? 'w-16' : 'w-64';
	});

	// Content padding reserves the rail's gutter. When hidden the content goes
	// full-bleed (no reflow when the peek floats over it). Never transitioned:
	// it changes in the same frame as the rail's width, so the page lays out once.
	const mainPaddingClass = computed(() => {
		if (effectiveHidden.value) return '';
		return isCollapsed.value ? 'lg:pl-16' : 'lg:pl-64';
	});

	// Desktop transform for the aside. When hidden it slides off-screen; the peek
	// brings it back over the content (no reflow — padding stays removed). Enter
	// uses the spring-bounce at motion-slow; exit uses ease-exit. Only `translate`
	// (and the peek's shadow) transition, both off the layout path; reduced motion
	// drops the slide outright (`motion-reduce:transition-none` on the aside).
	const sidebarDesktopClass = computed(() => {
		if (!effectiveHidden.value) {
			return 'lg:translate-x-0 duration-(--motion-moderate)';
		}
		return isPeeking.value
			? 'lg:translate-x-0 shadow-(--shadow-6) duration-(--motion-slow) ease-(--ease-spring-bounce)'
			: 'lg:-translate-x-full duration-(--motion-slow-exit) ease-(--ease-exit)';
	});

	return {
		isCollapsed,
		onToggleCollapse,
		sidebarToggleLabel,
		sidebarWidthClass,
		mainPaddingClass,
		sidebarDesktopClass,
	};
}
