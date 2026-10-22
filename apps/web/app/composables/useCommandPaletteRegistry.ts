import { markRaw, shallowRef, type ShallowRef } from 'vue';
import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';

/**
 * The providers contributed by mounted surfaces (and, later, plugins). Any
 * number of surfaces can register independently instead of one overwriting
 * another.
 *
 * Module state in a shallow ref rather than `useState`: a provider is a bag of
 * `build`/`run` closures, and `useState` would wrap every one of them in a deep
 * reactive proxy (and hand back proxies, not the registered objects). The app is
 * SPA-only, so a per-request store buys nothing. Each provider is `markRaw`ed and
 * the array is replaced on every change, so the palette's computed re-runs on
 * registration and removal and never on anything inside a provider.
 */
const providers: ShallowRef<readonly CommandPaletteProvider[]> = shallowRef([]);

/** The live registry, newest registration last. Read-only: register through the helper. */
export function useCommandPaletteRegistry(): Readonly<
	ShallowRef<readonly CommandPaletteProvider[]>
> {
	return providers;
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
 */
export function registerCommandPaletteProvider(provider: CommandPaletteProvider): void {
	onMounted(() => {
		if (providers.value.some((entry) => entry.id === provider.id)) {
			if (import.meta.dev) {
				console.warn(
					`[command-palette] provider id "${provider.id}" is already registered; ignoring the duplicate (first registrant wins).`
				);
			}
			return;
		}
		providers.value = [...providers.value, markRaw(provider)];
	});
	onBeforeUnmount(() => {
		providers.value = providers.value.filter((entry) => entry !== provider);
	});
}
