import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import Redis, { type Cluster } from 'ioredis';

const REDIS_IMAGE = 'redis:7-alpine';
const CLUSTER_NODE_COUNT = 3;
const CLUSTER_SLOT_COUNT = 16_384;
const PORT_MIN = 16_000;
const PORT_MAX = 25_000;

export interface RedisClusterFixture {
	client: Cluster;
	names: string[];
	ports: number[];
}

/** Set by CI (the `mta` test job) so a missing daemon or image fails the run. */
export const REQUIRE_DOCKER_ENV = 'OWLAT_REQUIRE_DOCKER';
// `docker image inspect` talks to the daemon, so it doubles as the liveness
// check. The timeout is generous because a loaded machine used to answer
// `docker info` too slowly for the old 5 s budget and skipped the suites.
const DOCKER_PROBE_TIMEOUT_MS = 30_000;

let probeError: unknown;
let probed = false;

/**
 * Gate for the suites that run against a real redis:7-alpine container
 * (`describe.runIf(dockerRedisAvailable())`). The suites never pull the image
 * themselves; `docker pull redis:7-alpine` once.
 *
 * Without `OWLAT_REQUIRE_DOCKER=1` a missing daemon or image skips the suites,
 * so the rest of the MTA tests still run on a machine without Docker. With the
 * flag set it throws instead, which fails the test file rather than reporting
 * the Redis tests as skipped.
 */
export function dockerRedisAvailable(): boolean {
	if (!probed) {
		probed = true;
		try {
			execFileSync('docker', ['image', 'inspect', REDIS_IMAGE], {
				stdio: 'ignore',
				timeout: DOCKER_PROBE_TIMEOUT_MS,
			});
		} catch (error) {
			probeError = error;
		}
	}
	if (probeError === undefined) return true;
	if (process.env[REQUIRE_DOCKER_ENV] === '1') {
		throw new Error(
			`${REQUIRE_DOCKER_ENV}=1 but Docker or the ${REDIS_IMAGE} image is unavailable; ` +
				`start Docker and run \`docker pull ${REDIS_IMAGE}\``,
			{ cause: probeError }
		);
	}
	return false;
}

function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once('error', () => resolve(false));
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(true));
		});
	});
}

async function findFreeClusterPort(excluded: ReadonlySet<number>): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const port = randomInt(PORT_MIN, PORT_MAX + 1);
		const busPort = port + 10_000;
		if (excluded.has(port) || excluded.has(busPort)) continue;
		if ((await canListen(port)) && (await canListen(busPort))) return port;
	}
	throw new Error('Could not allocate a Redis Cluster node and bus port');
}

async function allocatePorts(): Promise<number[]> {
	const ports: number[] = [];
	const excluded = new Set<number>();
	while (ports.length < CLUSTER_NODE_COUNT) {
		const port = await findFreeClusterPort(excluded);
		ports.push(port);
		excluded.add(port);
		excluded.add(port + 10_000);
	}
	return ports;
}

async function waitForOwnedNode(name: string, port: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const running = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', name], {
				encoding: 'utf8',
			}).trim();
			if (running !== 'true') throw new Error(`Container ${name} exited during startup`);
			const pong = execFileSync('docker', ['exec', name, 'redis-cli', '-p', String(port), 'ping'], {
				encoding: 'utf8',
			}).trim();
			if (pong === 'PONG') return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`Redis Cluster node ${name} did not become ready on port ${port}`);
}

async function waitForCluster(names: string[], ports: number[]): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt++) {
		const ready = names.every((name, index) => {
			try {
				const info = execFileSync(
					'docker',
					['exec', name, 'redis-cli', '-p', String(ports[index]), 'cluster', 'info'],
					{ encoding: 'utf8' }
				);
				return (
					info.includes('cluster_state:ok') &&
					info.includes(`cluster_slots_assigned:${CLUSTER_SLOT_COUNT}`) &&
					info.includes(`cluster_slots_ok:${CLUSTER_SLOT_COUNT}`) &&
					info.includes(`cluster_known_nodes:${CLUSTER_NODE_COUNT}`)
				);
			} catch {
				return false;
			}
		});
		if (ready) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Redis Cluster did not converge with full slot coverage');
}

function removeContainers(names: string[]): void {
	for (const name of names) {
		try {
			execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
		} catch {
			// The container may already have exited; --rm handles that case.
		}
	}
}

export async function startRedisClusterFixture(prefix: string): Promise<RedisClusterFixture> {
	let lastError: unknown;
	for (let setupAttempt = 0; setupAttempt < 3; setupAttempt++) {
		const suffix = randomUUID().slice(0, 8);
		const ports = await allocatePorts();
		const names = ports.map((_, index) => `owlat-${prefix}-${suffix}-${index}`);
		let client: Cluster | undefined;

		try {
			for (let index = 0; index < ports.length; index++) {
				execFileSync(
					'docker',
					[
						'run',
						'-d',
						'--rm',
						'--network',
						'host',
						'--name',
						names[index]!,
						REDIS_IMAGE,
						'redis-server',
						'--port',
						String(ports[index]),
						'--cluster-enabled',
						'yes',
						'--cluster-config-file',
						'nodes.conf',
						'--cluster-node-timeout',
						'5000',
						'--appendonly',
						'no',
						'--save',
						'',
						'--protected-mode',
						'no',
					],
					{ stdio: 'ignore' }
				);
			}
			await Promise.all(names.map((name, index) => waitForOwnedNode(name, ports[index]!)));
			execFileSync(
				'docker',
				[
					'run',
					'--rm',
					'--network',
					'host',
					REDIS_IMAGE,
					'redis-cli',
					'--cluster',
					'create',
					...ports.map((port) => `127.0.0.1:${port}`),
					'--cluster-replicas',
					'0',
					'--cluster-yes',
				],
				{ stdio: 'ignore', timeout: 15_000 }
			);
			await waitForCluster(names, ports);
			client = new Redis.Cluster(ports.map((port) => ({ host: '127.0.0.1', port })));
			await client.ping();
			await client.flushall();
			return { client, names, ports };
		} catch (error) {
			lastError = error;
			client?.disconnect();
			removeContainers(names);
		}
	}
	throw new Error('Could not start an isolated Redis Cluster fixture', { cause: lastError });
}

export function stopRedisClusterFixture(fixture: RedisClusterFixture | undefined): void {
	if (!fixture) return;
	fixture.client.disconnect();
	removeContainers(fixture.names);
}
