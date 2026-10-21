import type { InjectionKey } from 'vue';

/**
 * Provided as `true` by the dashboard layout. A page rendered inside the shell
 * falls back in place (the rail, header and palette stay usable); a standalone
 * page has nothing around it to keep working, so its render failures keep
 * going to Nuxt's full-page error screen.
 */
export const shellPageBoundaryKey: InjectionKey<boolean> = Symbol('shellPageBoundary');
