/**
 * Presence guard shared by the header `GlobalSearch` for the OS-global quick
 * switcher.
 *
 * The desktop app registers a system-wide Cmd/Ctrl+K that (incl. tray summon /
 * another app focused) is bridged by `useDesktopShortcuts` into a window
 * `owlat:quick-switcher` event. The Postbox `PostboxCommandPalette` also owns
 * that event (and the in-webview Cmd+K keydown), but it is mounted only on the
 * two Postbox routes that render `PostboxLayout` — not on the ~14 other Postbox
 * routes (search, contacts, migrate, label, settings/*). Routing by path is
 * therefore wrong on both ends: it would silence `GlobalSearch` on those 14
 * routes where no palette listens, and the `[folder]` segment can collide with
 * those names anyway.
 *
 * Instead `PostboxCommandPalette` publishes its presence by incrementing a
 * shared counter while mounted, and `GlobalSearch` defers iff that counter is
 * positive — i.e. exactly when a palette is actually listening. So the
 * OS-global shortcut always opens precisely one switcher.
 *
 * Lives in plain TS (not inlined in the SFC) so the pure decision can be
 * unit-tested without mounting a component. `usePostboxPaletteMounted` wraps
 * Nuxt's `useState` and must only be called from component setup.
 */

/**
 * `GlobalSearch` owns the global quick switcher iff no `PostboxCommandPalette`
 * is currently mounted (mount count 0). Pure so it can be unit-tested.
 */
export function ownsGlobalSwitcher(postboxPaletteMountCount: number): boolean {
	return postboxPaletteMountCount === 0;
}

/**
 * SSR-safe shared mount counter for `PostboxCommandPalette`. The palette
 * increments it in `onMounted` and decrements in `onBeforeUnmount`; readers
 * (`GlobalSearch`) feed `.value` into `ownsGlobalSwitcher`. Call from setup only.
 */
export function usePostboxPaletteMounted() {
	return useState<number>('postbox:palette-mounted', () => 0);
}
