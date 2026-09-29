// Re-export from the leaf `@owlat/email-builder/focus-mode` subpath so Nuxt
// auto-imports it as a composable without pulling the builder barrel (and with
// it the editor registry, SortableJS and the renderer) into the dashboard layout.
export { useFocusMode } from '@owlat/email-builder/focus-mode';
