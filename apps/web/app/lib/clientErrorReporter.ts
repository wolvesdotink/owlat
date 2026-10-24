/**
 * Sends an error to diagnostics without telling the user anything: for a
 * failure some other surface already shows (a pane boundary's fallback).
 * Provided app-wide by `plugins/error-handler.client.ts`.
 */
export type ClientErrorReporter = (error: unknown, source: string) => void;

/**
 * The provide/inject key for the reporter. Write it as
 * `'owlat:client-error-reporter' satisfies ClientErrorReporterKey` so a typo
 * fails the typecheck.
 *
 * A string literal type, not an exported Symbol: the provider is in the entry
 * bundle and the injector in a lazy chunk, and a module they both import at
 * runtime becomes a chunk of its own in the entry closure, which every page
 * downloads at boot (scripts/check-bundle-budget.ts).
 */
export type ClientErrorReporterKey = 'owlat:client-error-reporter';
