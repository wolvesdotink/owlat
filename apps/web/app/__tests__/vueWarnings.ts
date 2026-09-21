/**
 * Vue warnings that mean a mounted tree is not the one the browser paints.
 *
 * A component Vue could not resolve renders as an empty custom element, so a
 * suite asserting on the page around it passes whatever that component would
 * have shown; a required prop left out renders the component's fallback branch.
 * Both used to be a line in stderr that nobody read (481 and 18 per run). Here
 * they fail the test they happened in.
 *
 * The handler records rather than throws: Vue's `warn` guards against
 * re-entrancy with a flag it only resets after the handler returns, so a throw
 * from inside it would silence every later warning in the worker. `afterEach`
 * turns the record into a failure once the test body is done.
 */
import { afterEach } from 'vitest';
import { config } from '@vue/test-utils';
import type { AppConfig } from 'vue';

type WarnHandler = NonNullable<AppConfig['warnHandler']>;

const FATAL = [/^Failed to resolve component: /, /^Missing required prop: /];

const offences: string[] = [];

/** The suite-wide handler: fatal patterns fail the test, the rest still print. */
export const vueWarnHandler: WarnHandler = (message, _instance, trace) => {
	if (FATAL.some((pattern) => pattern.test(message))) offences.push(`${message}${trace}`);
	else console.warn(`[Vue warn]: ${message}${trace}`);
};

/**
 * THE ONE OPT-OUT, for the accessibility audits in `a11y.ts`: a page under audit
 * leaves its feature components unresolved on purpose so the audit stays about
 * the page's own chrome, and every name is handed to `record` so the audit can
 * still fail when a UI-layer component drops out. Everything else keeps the
 * suite-wide treatment.
 */
export function tolerateUnresolvedComponents(record: (name: string) => void): WarnHandler {
	return (message, instance, trace) => {
		const unresolved = /^Failed to resolve component: (\S+)/.exec(message);
		if (unresolved?.[1]) record(unresolved[1]);
		else vueWarnHandler(message, instance, trace);
	};
}

/** Drain the fatal warnings recorded since the last drain. */
export function takeVueWarnings(): string[] {
	return offences.splice(0);
}

/** Installed once by the vitest setup file. */
export function installVueWarnGuard(): void {
	config.global.config.warnHandler = vueWarnHandler;
	afterEach(() => {
		const report = takeVueWarnings();
		if (report.length === 0) return;
		throw new Error(
			`Vue warned while this test ran; register the component or pass the prop:\n${report.join('\n')}`
		);
	});
}
