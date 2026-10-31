/**
 * Runs the built web server (apps/web `nuxt build`, node-server preset) so the
 * updater talks to the real `/api/desktop/update/:target/:arch/:current`
 * route, with its Convex URL pointed at the fixture upstream.
 */

import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { defaultDeps } from './supervise';

export interface WebServer {
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;
	stop(): Promise<void>;
}

/** A port nothing listens on right now (Nitro reads `PORT=0` as 3000). */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

const READY = /Listening on (http:\/\/\S+)/;
const STOP_GRACE_MS = 5_000;

export async function startWebServer(options: {
	/** The `.output` directory of the web build. */
	readonly outputDir: string;
	readonly convexUrl: string;
	readonly readyWithinMs: number;
}): Promise<WebServer> {
	const port = await freePort();
	const child = spawn('node', [join(options.outputDir, 'server/index.mjs')], {
		env: {
			PATH: process.env['PATH'],
			HOME: process.env['HOME'],
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(port),
			NUXT_PUBLIC_CONVEX_URL: options.convexUrl,
		},
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const pgid = child.pid;
	const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
	const echo = (prefix: string) => (chunk: Buffer) => {
		for (const line of chunk.toString('utf8').split('\n')) {
			if (line) defaultDeps.echo(`[web] ${prefix}${line}`);
		}
	};
	child.stderr.on('data', echo(''));

	const stop = async () => {
		if (pgid === undefined) return;
		defaultDeps.signalGroup(pgid, 'SIGTERM');
		const kill = setTimeout(() => defaultDeps.signalGroup(pgid, 'SIGKILL'), STOP_GRACE_MS);
		await closed;
		clearTimeout(kill);
		defaultDeps.signalGroup(pgid, 'SIGKILL');
	};

	const origin = await new Promise<string>((resolve, reject) => {
		let output = '';
		const timer = setTimeout(
			() => reject(new Error(`the web server did not start within ${options.readyWithinMs}ms`)),
			options.readyWithinMs
		);
		child.stdout.on('data', (chunk: Buffer) => {
			echo('')(chunk);
			output += chunk.toString('utf8');
			const match = READY.exec(output);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]!.replace(/\/$/, ''));
			}
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`the web server exited with ${signal ?? `code ${code}`} before listening`));
		});
	}).catch(async (error: unknown) => {
		await stop();
		throw error;
	});

	return { origin, stop };
}
