/**
 * Helpers for talking to the local Convex backend from the setup CLI.
 *
 * The `/seed/*` and `/dev/*` endpoints are application `http.route` handlers,
 * which Convex serves on the SITE proxy port (3211), NOT the cloud/sync port
 * (3210). Posting to 3210 silently 404s (the cloud port serves the sync
 * protocol + the built-in `/version`, not the app HTTP router) — so the base
 * URL must default to the site proxy. The `INSTANCE_SECRET` lives in `.env`
 * (set during `runSetup()`) and must be sent on every `/seed/*` / `/dev/*`
 * request.
 */

import { join } from 'node:path';
import { log } from '@clack/prompts';
import pc from 'picocolors';
import { readEnv, type EnvMap } from './env';
import { progressSpinner } from './progress';

export interface BackendContext {
	baseUrl: string;
	instanceSecret: string;
	/** Where the operator signs in, for the success messages. */
	siteUrl: string;
}

/**
 * The web app's public URL as the install configured it. `SITE_URL` is the
 * canonical key; `NUXT_PUBLIC_SITE_URL` covers an `.env` written before it
 * existed, and a blank `.env` means the local dev stack.
 */
export function resolveSiteUrl(env: EnvMap): string {
	return env['SITE_URL'] || env['NUXT_PUBLIC_SITE_URL'] || 'http://localhost:3000';
}

export async function loadBackendContext(
	owlatDir: string,
	baseUrlOverride?: string
): Promise<BackendContext> {
	const envPath = join(owlatDir, '.env');
	const env = await readEnv(envPath);

	const instanceSecret = env['INSTANCE_SECRET'];
	if (!instanceSecret) {
		throw new Error(
			`No INSTANCE_SECRET in ${envPath}. Run \`owlat-setup setup\` (or \`bun run setup\`) first to bootstrap the env.`
		);
	}

	// `baseUrlOverride` is used by the on-box installer to force the *local*
	// site proxy (http://localhost:3211): for a domain install, CONVEX_SITE_URL
	// holds the PUBLIC URL (consumed by the function runtime), which isn't
	// reachable on-box until DNS + TLS are live. The installer talks to the
	// published port directly.
	const baseUrl =
		baseUrlOverride ||
		env['CONVEX_SITE_URL'] ||
		env['NUXT_PUBLIC_CONVEX_SITE_URL'] ||
		'http://localhost:3211';

	return { baseUrl, instanceSecret, siteUrl: resolveSiteUrl(env) };
}

export interface PostJsonOptions {
	path: string;
	body?: unknown;
	searchParams?: Record<string, string>;
}

function endpointUrl(ctx: BackendContext, opts: PostJsonOptions): string {
	const url = new URL(opts.path, ctx.baseUrl);
	for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
		url.searchParams.set(k, v);
	}
	return url.toString();
}

export async function postJson<T = unknown>(
	ctx: BackendContext,
	opts: PostJsonOptions
): Promise<{ status: number; body: T }> {
	const resp = await fetch(endpointUrl(ctx, opts), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Instance-Secret': ctx.instanceSecret,
		},
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	// Try JSON first; fall back to text. If both fail (already-consumed body,
	// aborted stream), surface an empty body rather than re-throwing — callers
	// rely on a stable { status, body } shape to decide how to report.
	let parsed: unknown = {};
	try {
		parsed = await resp.json();
	} catch {
		try {
			parsed = { raw: await resp.text() };
		} catch {
			parsed = {};
		}
	}
	return { status: resp.status, body: parsed as T };
}

/**
 * The human-readable message out of a backend refusal.
 *
 * The `/seed/*`, `/dev/*` and `/sample-data/*` endpoints answer failures in the
 * locked envelope `{ error: { category, message } }` (ADR-0036). The string
 * form (`{ error: "…" }`) is still accepted because the CLI is upgraded
 * independently of the backend it talks to, and an operator running a new CLI
 * against an older container should read the reason, not `[object Object]`.
 */
export function backendErrorMessage(body: unknown, fallback: string): string {
	if (body === null || typeof body !== 'object') return fallback;
	const error = (body as { error?: unknown }).error;
	if (typeof error === 'string' && error.length > 0) return error;
	if (error !== null && typeof error === 'object') {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string' && message.length > 0) return message;
	}
	return fallback;
}

export interface PostWithSpinnerOptions<T> {
	/** Prefix for the spinner line: `<label> — POST <url>`. Omitted, just `POST <url>`. */
	label?: string;
	/** Statuses that count as success. Defaults to `[200]`. */
	okStatuses?: readonly number[];
	/**
	 * The spinner's closing line on success, already coloured. A function when
	 * the text depends on which OK status came back. Defaults to a green `Done`.
	 */
	stopMessage?: string | ((status: number, body: T) => string);
	/** Logged under the failure when the endpoint answers 404 (a stale backend). */
	notFoundHint?: string;
}

/**
 * POST one backend endpoint under a spinner, reporting failures the same way
 * for every command: a transport error closes the spinner red and points at
 * the docker stack, a non-OK status closes it with the backend's own message
 * (plus `notFoundHint` on a 404). Returns `null` once a failure has been
 * reported, so the caller only exits 1; otherwise the status and body.
 */
export async function postWithSpinner<T = unknown>(
	ctx: BackendContext,
	request: PostJsonOptions,
	opts: PostWithSpinnerOptions<T> = {}
): Promise<{ status: number; body: T } | null> {
	const s = progressSpinner();
	const target = `POST ${endpointUrl(ctx, request)}`;
	s.start(opts.label ? `${opts.label} — ${target}` : target);

	let response: { status: number; body: T };
	try {
		response = await postJson<T>(ctx, request);
	} catch (e) {
		s.stop(pc.red(`Failed: ${(e as Error).message}`));
		log.error('Is the docker stack up? Try `docker compose up -d` first.');
		return null;
	}

	if (!(opts.okStatuses ?? [200]).includes(response.status)) {
		s.stop(pc.red(`Failed: ${backendErrorMessage(response.body, `HTTP ${response.status}`)}`));
		if (response.status === 404 && opts.notFoundHint) log.error(opts.notFoundHint);
		return null;
	}

	const { stopMessage = pc.green('Done') } = opts;
	s.stop(
		typeof stopMessage === 'function' ? stopMessage(response.status, response.body) : stopMessage
	);
	return response;
}
