/**
 * Node-side reporters for the setup provisioning progress protocol.
 *
 * The wire shape (sentinel, event types, step ids, `parseProgressLine`) lives in
 * `@owlat/shared/setupProgress` so the producer (this CLI) and consumers (the
 * desktop app) cannot drift. This module adds the two emitters used here:
 *  - {@link NullReporter} for the interactive TTY path (clack already shows
 *    progress, so there is nothing to emit);
 *  - the JSON reporter, enabled by `OWLAT_PROGRESS=json` (or
 *    `createReporter({ json: true })`), which writes one sentinel-prefixed NDJSON
 *    line per event to stdout WITHOUT changing the clack output (the sentinel
 *    keeps the two streams separable).
 *
 * The reporter is stateful: steps run sequentially in the quickstart pipeline,
 * so `step()` opens the "current" step and `ok()/warn()/fail()/skip()` close it.
 */

import { spinner as clackSpinner } from '@clack/prompts';
import pc from 'picocolors';
import {
	PROGRESS_SENTINEL,
	type ProgressEvent,
	type StepStatus,
} from '@owlat/shared/setupProgress';

// Re-export the shared wire protocol so existing imports from this module
// (`import { SetupStep, parseProgressLine, ... } from '../progress'`) keep working.
export {
	PROGRESS_SENTINEL,
	SetupStep,
	parseProgressLine,
	type SetupStepId,
	type StepStatus,
	type ProgressEvent,
	type ProgressStepEvent,
	type ProgressLogEvent,
	type ProgressDoneEvent,
} from '@owlat/shared/setupProgress';

export interface Reporter {
	/** True when this reporter emits machine-readable progress to stdout. */
	readonly isJson: boolean;
	/** Open a step (marks it `running`). */
	step(id: string, title: string): void;
	/** Update the current step's detail without closing it. */
	detail(detail: string): void;
	/** Close the current step successfully. */
	ok(detail?: string): void;
	/** Close the current step as a soft-failure (pipeline continues). */
	warn(detail?: string): void;
	/** Close the current step as failed. */
	fail(detail?: string): void;
	/** Close the current step as skipped (e.g. blank mode skips bootstrap). */
	skip(detail?: string): void;
	/** Emit a raw log line (only surfaced in JSON mode; ignored on a TTY). */
	log(line: string, stream?: 'stdout' | 'stderr'): void;
	/** Terminal event for the whole run. */
	done(ok: boolean, summary?: Record<string, unknown>): void;
}

interface ReporterOptions {
	json?: boolean;
	/** Sink for emitted lines — injectable for tests. Defaults to process.stdout. */
	write?: (line: string) => void;
	/** Clock — injectable for deterministic tests. Defaults to Date.now. */
	now?: () => number;
}

/**
 * A no-op reporter for the interactive TTY path: clack already shows progress,
 * so there is nothing to emit. Keeping the same interface means the pipeline
 * code is identical in both modes.
 */
class NullReporter implements Reporter {
	readonly isJson = false;
	step(): void {}
	detail(): void {}
	ok(): void {}
	warn(): void {}
	fail(): void {}
	skip(): void {}
	log(): void {}
	done(): void {}
}

/** Emits sentinel-prefixed NDJSON progress events. */
class JsonReporter implements Reporter {
	readonly isJson = true;
	private current: { id: string; title: string } | null = null;
	private readonly write: (line: string) => void;
	private readonly now: () => number;

	constructor(opts: ReporterOptions) {
		this.write = opts.write ?? ((line) => process.stdout.write(line));
		this.now = opts.now ?? (() => Date.now());
	}

	private emit(event: ProgressEvent): void {
		this.write(`${PROGRESS_SENTINEL}${JSON.stringify(event)}\n`);
	}

	private close(status: Exclude<StepStatus, 'running'>, detail?: string, warn?: boolean): void {
		if (!this.current) return;
		this.emit({
			v: 1,
			event: 'step',
			id: this.current.id,
			title: this.current.title,
			status,
			...(detail ? { detail } : {}),
			...(warn ? { warn: true } : {}),
			ts: this.now(),
		});
		this.current = null;
	}

	step(id: string, title: string): void {
		// Defensively close any still-open step as ok before opening the next.
		if (this.current) this.close('ok');
		this.current = { id, title };
		this.emit({ v: 1, event: 'step', id, title, status: 'running', ts: this.now() });
	}

	detail(detail: string): void {
		if (!this.current) return;
		this.emit({
			v: 1,
			event: 'step',
			id: this.current.id,
			title: this.current.title,
			status: 'running',
			detail,
			ts: this.now(),
		});
	}

	ok(detail?: string): void {
		this.close('ok', detail);
	}

	warn(detail?: string): void {
		this.close('ok', detail, true);
	}

	fail(detail?: string): void {
		this.close('failed', detail);
	}

	skip(detail?: string): void {
		this.close('skipped', detail);
	}

	log(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
		this.emit({ v: 1, event: 'log', line, stream, ts: this.now() });
	}

	done(ok: boolean, summary?: Record<string, unknown>): void {
		// Close any dangling step first so the timeline is consistent.
		if (this.current) this.close(ok ? 'ok' : 'failed');
		this.emit({ v: 1, event: 'done', ok, ...(summary ? { summary } : {}), ts: this.now() });
	}
}

/**
 * Build a reporter. JSON mode is selected by the explicit `json` option or the
 * `OWLAT_PROGRESS=json` environment variable; otherwise a no-op reporter is
 * returned so the interactive clack output is the only thing on screen.
 */
export function createReporter(opts: ReporterOptions = {}): Reporter {
	const json = opts.json ?? process.env['OWLAT_PROGRESS'] === 'json';
	return json ? new JsonReporter(opts) : new NullReporter();
}

/**
 * A clack spinner on a TTY; inert in NDJSON mode. Spinner frames are drawn
 * with carriage returns, which a line-based consumer (the desktop installer
 * log) renders as hundreds of junk lines that bury real errors.
 */
export function progressSpinner(): {
	start: (msg?: string) => void;
	stop: (msg?: string, code?: number) => void;
	message: (msg?: string) => void;
} {
	if (process.env['OWLAT_PROGRESS'] === 'json') {
		return { start() {}, stop() {}, message() {} };
	}
	return clackSpinner();
}

/**
 * Run an async credential check under a clack spinner, stopping it with a green
 * ✓ / red ✗ line. Returns whether the check passed. Shared by every provider
 * picker (sending, AI, integrations) so the live-validation UX is identical.
 */
export async function validateWithSpinner(
	label: string,
	run: () => Promise<{ ok: boolean; message: string }>
): Promise<boolean> {
	const s = progressSpinner();
	s.start(label);
	const result = await run();
	s.stop(result.ok ? pc.green(`✓ ${result.message}`) : pc.red(`✗ ${result.message}`));
	return result.ok;
}
