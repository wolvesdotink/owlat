import type { InjectionKey } from 'vue';

/**
 * Sends an error to diagnostics without telling the user anything: for a
 * failure some other surface already shows (a pane boundary's fallback).
 * Provided app-wide by `plugins/error-handler.client.ts`.
 */
export type ClientErrorReporter = (error: unknown, source: string) => void;

export const clientErrorReporterKey: InjectionKey<ClientErrorReporter> =
	Symbol('clientErrorReporter');
