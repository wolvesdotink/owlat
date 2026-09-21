import { createServer } from 'node:http';
import { installCrashHandlers, installShutdown } from '@owlat/shared/nodeShutdown';
import { buildRequestListener, PORT } from './server.js';
import { setShutdownHandle } from './lifecycle.js';

const log = (message: string, detail?: unknown) => {
	if (detail === undefined) console.info(`[updater] ${message}`);
	else console.error(`[updater] ${message}`, detail);
};

installCrashHandlers({ log });

const server = createServer(buildRequestListener());

// 9s, just inside Docker's default 10s stop grace period (this service declares
// no stop_grace_period of its own). What this buys is the file half of each
// endpoint: the sequences that write `.env`, the compose override and the flag
// mirror run to completion instead of stopping between two of them.
//
// It does NOT cover the container half. `exec` is execFileSync, so a `docker
// compose pull` or a convex-deploy run blocks the event loop for as long as it
// takes — neither this handler nor its watchdog can run while one is in flight,
// and Docker's SIGKILL lands first. See the note in the PR: that needs an async
// exec and a real stop_grace_period, not a bigger timeout here.
setShutdownHandle(installShutdown({ server, timeoutMs: 9_000, log }));

server.listen(PORT, '0.0.0.0', () => {
	console.info(`Updater sidecar listening on port ${PORT}`);
});
