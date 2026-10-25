import { spawn } from 'node:child_process';

/** redis:7 logs this once it listens for clients. */
export const REDIS_READY_LOG = 'Ready to accept connections';

/** A cluster node logs this once every slot is served by a reachable master. */
export const REDIS_CLUSTER_OK_LOG = 'Cluster state changed: ok';

/**
 * Resolve once container `name` has written a log line containing `marker`.
 *
 * `docker logs --follow` replays the whole log before following it, so a line
 * written before this call is still seen. A container that exits without the
 * line ends the stream, and the promise rejects instead of hanging. The
 * follower process is stopped either way.
 */
export function awaitContainerLog(name: string, marker: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const follower = spawn('docker', ['logs', '--follow', name], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		// Only the tail that could still hold the start of a split marker is kept.
		let tail = '';
		let found = false;
		const scan = (chunk: Buffer): void => {
			if (found) return;
			const text = tail + chunk.toString('utf8');
			if (text.includes(marker)) {
				found = true;
				follower.kill();
				resolve();
				return;
			}
			tail = text.slice(-marker.length);
		};
		follower.stdout.on('data', scan);
		follower.stderr.on('data', scan);
		follower.on('error', reject);
		follower.on('close', (code) => {
			if (found) return;
			reject(new Error(`container ${name} stopped logging before "${marker}" (exit ${code})`));
		});
	});
}
