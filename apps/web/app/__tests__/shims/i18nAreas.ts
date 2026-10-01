/**
 * Test-time stand-in for the build's `#build/owlat-i18n-areas.mjs` (written by
 * i18n/catalogModule.ts). Suites mount the source catalogs whole, like the dev
 * server, so there are no area chunks to load; a suite that exercises the
 * loader mocks this module with its own manifest.
 */
import type { AreaChunks, AreaRouteEntry } from '~~/i18n/areaRuntime';

export const areaRoutes: readonly AreaRouteEntry[] = [];
export const messageRoots: readonly string[] = [];
export const areaChunks: AreaChunks = {};
