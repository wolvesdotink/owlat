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
 *
 * Write the key as `'owlat:shell-page-boundary' satisfies ShellPageBoundaryKey`
 * so a typo fails the typecheck. It is a string literal type, not an exported
 * Symbol, for the same reason: a module that the entry and the layout chunk
 * both import at runtime becomes a chunk of its own in the entry closure.
 */
export type ShellPageBoundaryKey = 'owlat:shell-page-boundary';
