/**
 * Whether the public hostnames chosen for an install reach THIS server on the
 * ports Caddy needs (80 for the HTTP-01 challenge and the redirect, 443 for
 * HTTPS), checked before setup writes anything.
 *
 * Comparing a hostname's A record with this machine's addresses is wrong behind
 * NAT (a cloud instance whose public address is not on any interface), so the
 * check instead listens on the port itself with a one-time token and connects
 * to each hostname: only a connection that lands on this listener reads the
 * token back. A port something else already holds proves nothing about where
 * a name points, so it is reported, with how to free it, rather than tested.
 *
 * The connection starts on this server, so a provider firewall that filters
 * only traffic from outside is not seen; the messages say so.
 */

import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createConnection, createServer, type Server } from 'node:net';

/** Ports Caddy must be reachable on to obtain and serve its certificates. */
export const EDGE_PORTS = [80, 443] as const;

/** How long one connection attempt may take before it counts as unreachable. */
const CONNECT_TIMEOUT_MS = 5_000;

export interface HostCheckDeps {
	/** IPv4 addresses a hostname resolves to; empty when it does not resolve. */
	resolve: (host: string) => Promise<string[]>;
	/** Start the token listener on `port`; the error code when it cannot. */
	listen: (port: number, token: string) => Promise<{ close: () => Promise<void> } | string>;
	/** Connect to `address:port`; the first bytes read, or `null` when it did not connect. */
	connect: (address: string, port: number) => Promise<string | null>;
	token: () => string;
}

async function resolveIpv4(host: string): Promise<string[]> {
	try {
		return (await lookup(host, { all: true, family: 4 })).map((entry) => entry.address);
	} catch {
		return [];
	}
}

function listenWithToken(
	port: number,
	token: string
): Promise<{ close: () => Promise<void> } | string> {
	return new Promise((resolve) => {
		const server: Server = createServer((socket) => socket.end(token));
		server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
		server.listen({ port, host: '0.0.0.0', exclusive: true }, () =>
			resolve({ close: () => new Promise<void>((done) => server.close(() => done())) })
		);
	});
}

function connectAndRead(address: string, port: number): Promise<string | null> {
	return new Promise((resolve) => {
		let received = '';
		let connected = false;
		const socket = createConnection({ host: address, port });
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
		socket.on('connect', () => {
			connected = true;
		});
		socket.on('data', (chunk) => {
			received += chunk.toString('utf-8');
		});
		socket.on('error', () => undefined);
		socket.on('close', () => resolve(connected ? received : null));
	});
}

export const defaultHostCheckDeps: HostCheckDeps = {
	resolve: resolveIpv4,
	listen: listenWithToken,
	connect: connectAndRead,
	token: () => randomBytes(16).toString('hex'),
};

const FIREWALL_HINT =
	"point the A record at this server, and allow the port in this server's firewall and in your provider's firewall";

/**
 * The problems that stop these hostnames from serving Owlat, each with its fix;
 * empty when every hostname resolves and reaches this server on 80 and 443.
 */
export async function checkPublicHosts(
	hosts: readonly string[],
	deps: HostCheckDeps = defaultHostCheckDeps
): Promise<string[]> {
	const problems: string[] = [];
	const resolved = new Map<string, string>();
	for (const host of hosts) {
		const [address] = await deps.resolve(host);
		if (address) resolved.set(host, address);
		else {
			problems.push(
				`${host} does not resolve. Create an A record for it pointing at this server's public IPv4 address.`
			);
		}
	}
	if (resolved.size === 0) return problems;

	for (const port of EDGE_PORTS) {
		const token = deps.token();
		const listener = await deps.listen(port, token);
		if (listener === 'EADDRINUSE') {
			problems.push(
				`Port ${port} is already in use on this server, so it cannot be tested. If Caddy serves the current address, stop it with \`docker compose --profile tls stop caddy\` and check again; \`owlat apply\` starts it with the new address.`
			);
			continue;
		}
		if (typeof listener === 'string') {
			problems.push(
				`Could not listen on port ${port} to test it (${listener}). Run the installer as root on the server itself.`
			);
			continue;
		}
		try {
			for (const [host, address] of resolved) {
				if ((await deps.connect(address, port)) !== token) {
					problems.push(
						`Port ${port} on ${host} (${address}) does not reach this server: ${FIREWALL_HINT}.`
					);
				}
			}
		} finally {
			await listener.close();
		}
	}
	return problems;
}
