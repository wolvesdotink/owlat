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
import { readEnv } from './env';

export interface BackendContext {
	baseUrl: string;
	instanceSecret: string;
}

export async function loadBackendContext(owlatDir: string, baseUrlOverride?: string): Promise<BackendContext> {
	const envPath = join(owlatDir, '.env');
	const env = await readEnv(envPath);

	const instanceSecret = env['INSTANCE_SECRET'];
	if (!instanceSecret) {
		throw new Error(
			`No INSTANCE_SECRET in ${envPath}. Run \`owlat-setup setup\` (or \`bun run setup\`) first to bootstrap the env.`,
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

	return { baseUrl, instanceSecret };
}

export interface PostJsonOptions {
	path: string;
	body?: unknown;
	searchParams?: Record<string, string>;
}

export async function postJson<T = unknown>(
	ctx: BackendContext,
	opts: PostJsonOptions,
): Promise<{ status: number; body: T }> {
	const url = new URL(opts.path, ctx.baseUrl);
	for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
		url.searchParams.set(k, v);
	}
	const resp = await fetch(url.toString(), {
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
