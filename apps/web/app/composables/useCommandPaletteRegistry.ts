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
 * component. Client-only (the provider holds closures). Call from setup only.
 *
 * Matches the pure registry's first-claimant-wins rule: if an id is already
 * registered by a *live* component, this registration is ignored (a dev warning
 * is logged) — a later contributor can never shadow or replace an earlier
 * provider by reusing its id, which is the trust boundary plugin-originated
 * registration will lean on. A surface that unmounts then remounts still
 * re-registers cleanly, because unmount removes the entry by identity rather
 * than by id: the old object is gone before the remount's fresh descriptor
 * claims the id, and a stale same-id unmount can never delete a different,
 * still-mounted survivor's registration.
 *
 * Identity is compared through `toRaw` because `useState` deep-reactive-wraps
 * the stored array, so the entry read back is a proxy of `provider`, not
 * `provider` itself — a bare `entry !== provider` would never match and would
 * leak every registration.
 */
export function registerCommandPaletteProvider(provider: CommandPaletteProvider): void {
	const registry = useCommandPaletteRegistry();
	onMounted(() => {
		if (registry.value.some((entry) => entry.id === provider.id)) {
			if (import.meta.dev) {
				console.warn(
					`[command-palette] provider id "${provider.id}" is already registered; ignoring the duplicate (first registrant wins).`
				);
			}
			return;
		}
		registry.value = [...registry.value, provider];
	});
	onBeforeUnmount(() => {
		registry.value = registry.value.filter((entry) => toRaw(entry) !== provider);
	});
}
