/** A page can lend its navigation to the shell without duplicating its queries. */
export function useSectionNavigation() {
	const sections = useState<Array<{ id: string; title: string }>>(
		'shell-section-navigation',
		() => []
	);
	const showAppNavigation = useState('shell-show-app-navigation', () => false);
	const activeSection = computed(() => sections.value.at(-1) ?? null);

	function register(id: string, title: string) {
		sections.value = [...sections.value.filter((section) => section.id !== id), { id, title }];
		showAppNavigation.value = false;
	}

	function unregister(id: string) {
		sections.value = sections.value.filter((section) => section.id !== id);
	}

	return { activeSection, showAppNavigation, register, unregister };
}
