/**
 * Setup provisioning progress — the wire protocol shared by the producer
 * (`apps/setup-cli`, which emits it) and consumers (the desktop app, which
 * parses it off an SSH stream to drive an animated timeline).
 *
 * When `OWLAT_PROGRESS=json`, the setup CLI writes one line per step lifecycle
 * event to stdout, each prefixed with {@link PROGRESS_SENTINEL}:
 *
 *     @@OWLAT_PROGRESS@@{"v":1,"event":"step","id":"compose-up",...}
 *
 * The sentinel lets the existing human (clack) output stay untouched: a consumer
 * filters sentinel lines as {@link ProgressEvent}s and treats every other line
 * as raw installer log output.
 *
 * This module is the single source of truth for the shape — it has no runtime
 * dependencies so both a Node CLI and a browser/Tauri webview can import it.
 */

export const PROGRESS_SENTINEL = '@@OWLAT_PROGRESS@@';

/** Canonical, stable step identifiers a consumer can map to UI rows. */
export const SetupStep = {
	Preflight: 'preflight',
	Config: 'config',
	ComposeUp: 'compose-up',
	MtaIdentity: 'mta-identity',
	WaitConvex: 'wait-convex',
	AdminKey: 'admin-key',
	DeployFunctions: 'deploy-functions',
	EnvSet: 'env-set',
	WaitRoutes: 'wait-routes',
	BootstrapAdmin: 'bootstrap-admin',
	SeedDemo: 'seed-demo',
} as const;

export type StepStatus = 'running' | 'ok' | 'failed' | 'skipped';

export interface ProgressStepEvent {
	v: 1;
	event: 'step';
	id: string;
	title: string;
	status: StepStatus;
	/** Short human-readable detail for the current status. */
	detail?: string;
	/** A soft-failure: the step did not fully succeed but the pipeline continues. */
	warn?: boolean;
	ts: number;
}

export interface ProgressLogEvent {
	v: 1;
	event: 'log';
	line: string;
	stream: 'stdout' | 'stderr';
	ts: number;
}

export interface ProgressDoneEvent {
	v: 1;
	event: 'done';
	ok: boolean;
	summary?: Record<string, unknown>;
	ts: number;
}

export type ProgressEvent = ProgressStepEvent | ProgressLogEvent | ProgressDoneEvent;

/**
 * Parse one line of installer output into a {@link ProgressEvent}, or `null` if
 * it is not a sentinel-prefixed progress line (i.e. it is raw log output).
 *
 * A sentinel line whose JSON does not hold one of the three events, with every
 * field the consumer reads of the right type, is not a progress line either: a
 * consumer reads `status`, `stream` and `ok` straight off the event to drive
 * its timeline. Fields this build does not know are kept, so a producer may add
 * one. Step ids stay open strings (see {@link SetupStep}).
 */
export function parseProgressLine(line: string): ProgressEvent | null {
	const idx = line.indexOf(PROGRESS_SENTINEL);
	if (idx === -1) return null;
	const json = line.slice(idx + PROGRESS_SENTINEL.length).trim();
	if (!json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		// Not valid JSON after the sentinel — treat as raw output.
		return null;
	}
	return isProgressEvent(parsed) ? parsed : null;
}

type Fields = { readonly [key: string]: unknown };

const STEP_STATUSES: ReadonlySet<unknown> = new Set<StepStatus>([
	'running',
	'ok',
	'failed',
	'skipped',
]);
const LOG_STREAMS: ReadonlySet<unknown> = new Set<ProgressLogEvent['stream']>(['stdout', 'stderr']);

function isFields(value: unknown): value is Fields {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProgressEvent(value: unknown): value is ProgressEvent {
	if (!isFields(value) || value['v'] !== 1) return false;
	const ts = value['ts'];
	if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
	switch (value['event']) {
		case 'step':
			return (
				typeof value['id'] === 'string' &&
				typeof value['title'] === 'string' &&
				STEP_STATUSES.has(value['status']) &&
				optional(value['detail'], 'string') &&
				optional(value['warn'], 'boolean')
			);
		case 'log':
			return typeof value['line'] === 'string' && LOG_STREAMS.has(value['stream']);
		case 'done':
			return (
				typeof value['ok'] === 'boolean' &&
				(value['summary'] === undefined || isFields(value['summary']))
			);
		default:
			return false;
	}
}

function optional(value: unknown, type: 'string' | 'boolean'): boolean {
	return value === undefined || typeof value === type;
}
