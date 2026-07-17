import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';

/**
 * Reactive backing store for command-palette providers contributed by mounted
 * surfaces (and, later, plugins). Replaces the single `cmdk:surface-groups`
 * bucket: any number of surfaces can register independently instead of one
 * overwriting another.
 *
 * Providers carry `build`/`run` closures, so registration only ever happens on
 * the client (`onMounted`). SSR keeps the empty default and never tries to
 * serialize a function — the palette is a client-opened modal, so this matches
 * how the old surface bucket behaved.
 */
export function useCommandPaletteRegistry(): Ref<CommandPaletteProvider[]> {
	return useState<CommandPaletteProvider[]>('cmdk:providers', () => []);
}

/**
 * Register `provider` in the palette registry for the lifetime of the calling
 * component. Client-only (the provider holds closures). Registering an id that
 * is already present replaces that entry, so a surface that re-registers on
 * navigation stays deduplicated; unmounting removes exactly this provider and
 * leaves any others untouched. Call from component setup only.
 */
export function registerCommandPaletteProvider(provider: CommandPaletteProvider): void {
	const registry = useCommandPaletteRegistry();
	onMounted(() => {
		registry.value = [...registry.value.filter((entry) => entry.id !== provider.id), provider];
	});
	onBeforeUnmount(() => {
		registry.value = registry.value.filter((entry) => entry.id !== provider.id);
	});
}
