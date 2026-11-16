import { TRANSACTIONAL } from '~/lib/breadcrumbRoutes';

/**
 * "Transactional › <name>" for a page about one transactional email. Until the
 * name has loaded, the route table's own trail for the page stands in.
 */
export function useTransactionalBreadcrumbs(name: () => string | undefined) {
	const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();
	watch(
		name,
		(current) => {
			if (!current) return;
			setDynamicBreadcrumbs([
				{ label: TRANSACTIONAL.section, href: TRANSACTIONAL.sectionHref },
				{ label: current },
			]);
		},
		{ immediate: true }
	);
	onUnmounted(clearDynamicBreadcrumbs);
}
