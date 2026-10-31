/**
 * What the packaged app says on its output streams, read line by line.
 *
 * A fixture build (`--features e2e-fixture`, apps/desktop/src-tauri/src/e2e.rs)
 * started with `OWLAT_E2E_REPORT=1` prints one `owlat-e2e {json}` line per step:
 * `boot`, `mounted`, `renderer-error`, the update steps and `done`. Every line,
 * from any build, is also scanned for output that only a broken launch
 * produces.
 */

export const REPORT_PREFIX = 'owlat-e2e ';

export interface Report {
	readonly event: string;
	readonly pid: number;
	readonly [field: string]: unknown;
}

/** The report a line carries, or null for ordinary output. */
export function parseReport(line: string): Report | null {
	const start = line.indexOf(REPORT_PREFIX);
	if (start === -1) return null;
	try {
		const value: unknown = JSON.parse(line.slice(start + REPORT_PREFIX.length));
		if (typeof value !== 'object' || value === null) return null;
		const { event, pid } = value as { event?: unknown; pid?: unknown };
		if (typeof event !== 'string' || typeof pid !== 'number') return null;
		return value as Report;
	} catch {
		return null;
	}
}

/**
 * Output that means the launch is broken whatever happens next. Kept narrow on
 * purpose: WebKitGTK and GTK print plenty of harmless warnings under xvfb, and
 * a pattern that matches one of those would fail every run.
 */
const FATAL_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
	{ label: 'Rust panic', pattern: /\bpanicked at\b/ },
	{ label: 'missing shared library', pattern: /error while loading shared libraries/ },
	{ label: 'native crash', pattern: /Segmentation fault|core dumped/ },
	{ label: 'no display', pattern: /cannot open display:|Failed to initialize GTK/ },
	{ label: 'no EGL display', pattern: /Could not create default EGL display/ },
	{ label: 'AppImage runtime', pattern: /Cannot mount AppImage|error loading libfuse/ },
	{ label: 'web process crash', pattern: /WebProcess CRASHED|web process (?:crashed|terminated)/i },
];

/** The label of the fatal pattern a line matches, or null. */
export function fatalMatch(line: string): string | null {
	return FATAL_PATTERNS.find(({ pattern }) => pattern.test(line))?.label ?? null;
}
