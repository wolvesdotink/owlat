/**
 * The two upstreams the update route and the updater talk to, on one loopback
 * port:
 *
 * - a Convex deployment, as far as the route's `ConvexHttpClient` can tell:
 *   `POST /api/query` for `desktop/updates:manifestForClient`, answering with
 *   the manifest the scenario set (or null, which the route turns into 204);
 * - GitHub's release-asset download path, serving the bundle bytes the
 *   scenario set.
 *
 * The web server's own update route sits between the app and the first of
 * these unchanged, so the scenario exercises the route as deployed. Every
 * query and download is recorded for the scenario's assertions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MANIFEST_QUERY = 'desktop/updates:manifestForClient';

export interface ManifestQuery {
	readonly target: unknown;
	readonly arch: unknown;
	readonly currentVersion: unknown;
}

export interface FixtureServer {
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;
	readonly queries: ManifestQuery[];
	readonly downloads: string[];
	/** The manifest the next queries answer with; null means "no update". */
	setManifest(manifest: { readonly text: string; readonly version: string } | null): void;
	/** Serve `bytes` at `path`; every other path is a 404. */
	setAsset(path: string, bytes: Uint8Array): void;
	close(): Promise<void>;
}

interface QueryBody {
	readonly path?: unknown;
	readonly args?: readonly unknown[];
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify(body));
}

export function startFixtureServer(): Promise<FixtureServer> {
	const queries: ManifestQuery[] = [];
	const downloads: string[] = [];
	let manifest: { text: string; version: string } | null = null;
	const assets = new Map<string, Uint8Array>();

	const answerQuery = (body: QueryBody, response: ServerResponse) => {
		if (body.path !== MANIFEST_QUERY) {
			json(response, 200, {
				status: 'error',
				errorMessage: `fixture serves only ${MANIFEST_QUERY}, not ${String(body.path)}`,
				logLines: [],
			});
			return;
		}
		const args = (body.args?.[0] ?? {}) as Record<string, unknown>;
		queries.push({
			target: args['target'],
			arch: args['arch'],
			currentVersion: args['currentVersion'],
		});
		const value = manifest && { manifest: manifest.text, version: manifest.version };
		json(response, 200, { status: 'success', value, logLines: [] });
	};

	const server = createServer((request, response) => {
		const path = new URL(request.url ?? '/', 'http://fixture').pathname;
		if (request.method === 'POST' && path === '/api/query') {
			void readBody(request)
				.then((raw) => answerQuery(JSON.parse(raw) as QueryBody, response))
				.catch(() => json(response, 400, { status: 'error', errorMessage: 'bad request body' }));
			return;
		}
		const asset = request.method === 'GET' ? assets.get(path) : undefined;
		if (!asset) {
			response.writeHead(404).end();
			return;
		}
		downloads.push(path);
		response.writeHead(200, {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(asset.byteLength),
		});
		response.end(asset);
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				origin: `http://127.0.0.1:${port}`,
				queries,
				downloads,
				setManifest: (next) => {
					manifest = next && { ...next };
				},
				setAsset: (assetPath, bytes) => {
					assets.set(assetPath, bytes);
				},
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
