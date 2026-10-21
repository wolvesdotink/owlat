import type { Component, InjectionKey } from 'vue';

/**
 * Provided by the dashboard layout: the page boundary component
 * (AppErrorBoundary). A page rendered inside the shell falls back in place
 * (the rail, header and palette stay usable); a standalone page has nothing
 * around it to keep working, so its render failures keep going to Nuxt's
 * full-page error screen.
 *
 * It carries the component itself rather than a flag so that AppPageOutlet,
 * which app.vue renders, does not import the boundary statically: the
 * boundary then loads with the layout instead of with the entry bundle.
 */
export const shellPageBoundaryKey: InjectionKey<Component> = Symbol('shellPageBoundary');
