import { JWT_PATTERN } from './scanReportSecrets';

/**
 * Redact text the suite itself writes into the Playwright report: the setup
 * project's browser console and network log, and error messages that quote a
 * request.
 *
 * The report is a public artifact, and the scan before upload deletes the whole
 * report when it finds a deployment URL or a JWT in it
 * (scan-report-secrets.ts). That is right for a leak nobody expected, but the
 * console of a failing run names the deployment as a matter of course (a
 * WebSocket error quotes its URL), and that run is the one whose report is
 * needed. So what the suite writes is redacted where it is written, and the scan
 * stays the backstop.
 */

const JWT_GLOBAL = new RegExp(JWT_PATTERN.source, 'g');

/** Deployment URLs by the placeholder that replaces their host, e.g. `{ convex: url }`. */
export type Deployments = Record<string, string | undefined>;

/** The test deployment's URLs, as the workflow hands them to the suite. */
export function testDeployments(): Deployments {
	return {
		convex: process.env['NUXT_PUBLIC_CONVEX_URL'],
		'convex-site': process.env['NUXT_PUBLIC_CONVEX_SITE_URL'],
	};
}

function hostOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname || null;
	} catch {
		return null;
	}
}

function escapeRegExp(text: string): string {
	return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `text` with each deployment's host replaced by `[<label>]`, in any scheme
 * (`https://[convex]/…`, `wss://[convex]/…`, a bare host in a DNS error), and
 * every JWT-shaped value replaced by `[JWT]`.
 */
export function redactForReport(text: string, deployments: Deployments): string {
	let result = text;
	for (const [label, url] of Object.entries(deployments)) {
		const host = hostOf(url);
		if (host) result = result.replaceAll(new RegExp(escapeRegExp(host), 'gi'), `[${label}]`);
	}
	return result.replaceAll(JWT_GLOBAL, '[JWT]');
}

/**
 * One request as a line of the setup's network log: method, redacted origin
 * and path, outcome. The query string is dropped, and headers and bodies are
 * never read, so nothing but the path can carry data.
 */
export function describeRequest(
	request: { method: string; url: string; outcome: string },
	deployments: Deployments
): string {
	let where = request.url;
	try {
		const url = new URL(request.url);
		where = `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		// Not a URL; redacting the raw text is the best that can be done.
	}
	return redactForReport(`${request.method} ${where} ${request.outcome}`, deployments);
}

/**
 * The error for a request to the deployment that got no response. The original
 * error is not chained: its cause can name the host (`getaddrinfo ENOTFOUND
 * <host>`), and an error ends up in the public report. Only the error code
 * (`ECONNREFUSED`, `ENOTFOUND`, ...) is kept.
 */
export function unreachableError(request: string, error: unknown): Error {
	// Node's fetch puts the code on the cause, Bun's on the error itself.
	const failure = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
	const raw = failure?.cause?.code ?? failure?.code;
	const code = typeof raw === 'string' ? ` (${raw})` : '';
	const what = failure?.name === 'TimeoutError' ? 'timed out' : 'did not reach the deployment';
	return new Error(`${request} ${what}${code}.`);
}
