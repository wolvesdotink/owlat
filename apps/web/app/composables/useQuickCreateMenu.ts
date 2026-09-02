import {
	defaultQuickCreateEntry,
	quickCreateEntriesFor,
	type QuickCreateEntry,
} from '~/lib/quickCreate';

/**
 * The quick-create registry, resolved for the person looking at it: the verbs
 * their flags and role allow, already translated and already runnable.
 *
 * The reactive half of `lib/quickCreate.ts` — same split as
 * `useDashboardNavigation` over `lib/dashboardNavigation.ts`. The header
 * split-button and the mobile create sheet both read THIS, so the two menus
 * cannot offer different verbs, and neither re-implements what "run it" means:
 * a verb with an `href` is a page, and the two that are overlays go through
 * `useQuickCreate`, the same entry point the command palette's create verbs use.
 */
export interface QuickCreateAction extends QuickCreateEntry {
	/** The entry's `labelKey`, translated. */
	label: string;
	run: () => void;
}

export function useQuickCreateMenu() {
	const { t } = useI18n();
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isDesktop } = useDesktopContext();
	const { role } = usePermissions();
	const { openCompose, openNewContact } = useQuickCreate();

	const environment = computed(() => ({
		isFeatureEnabled,
		isDesktop: isDesktop.value,
		role: role.value,
	}));

	function perform(entry: QuickCreateEntry): void {
		if (entry.href) {
			void navigateTo(entry.href);
			return;
		}
		if (entry.id === 'compose') {
			void openCompose();
			return;
		}
		void openNewContact();
	}

	const toAction = (entry: QuickCreateEntry): QuickCreateAction => ({
		...entry,
		label: t(entry.labelKey),
		run: () => perform(entry),
	});

	/** Every verb this member may run, in registry order. */
	const actions = computed<QuickCreateAction[]>(() =>
		quickCreateEntriesFor(environment.value).map(toAction)
	);

	/** What the split button's primary half does; `null` when there is nothing to create. */
	const defaultAction = computed<QuickCreateAction | null>(() => {
		const entry = defaultQuickCreateEntry(environment.value);
		return entry ? toAction(entry) : null;
	});

	/** The compose verb specifically, for the `c` chord — absent when mail is off. */
	const composeAction = computed<QuickCreateAction | null>(
		() => actions.value.find((action) => action.id === 'compose') ?? null
	);

	return { actions, defaultAction, composeAction };
}
