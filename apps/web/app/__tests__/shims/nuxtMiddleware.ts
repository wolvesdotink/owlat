/**
 * Test-time stand-in for Nuxt's `#build/middleware` (the global middleware and
 * one lazy import per named middleware). A suite that loads middleware mocks
 * this module with its own.
 */
export const globalMiddleware: unknown[] = [];
export const namedMiddleware: Record<string, () => Promise<unknown>> = {};
