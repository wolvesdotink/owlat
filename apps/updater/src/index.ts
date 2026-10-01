import { createServer } from 'node:http';
import { installCrashHandlers, installShutdown } from '@owlat/shared/nodeShutdown';
import { buildRequestListener, PORT } from './server.js';
import {
	beginShutdown,
	exitAfterStoppingChildren,
	setShutdownHandle,
	SHUTDOWN_DEADLINE_MS,
} from './lifecycle.js';
import { reconcileInterruptedUpdate } from './update.js';

const log = (message: string, detail?: unknown) => {
	if (detail === undefined) console.info(`[updater] ${message}`);
	else console.error(`[updater] ${message}`, detail);
};

installCrashHandlers({ log });

// A rollout the previous process never finished is settled before anything
// else is served: its record says so in words, and a template it had only
// staged is removed.
await reconcileInterruptedUpdate();

const server = createServer(buildRequestListener());

// The budget is in lifecycle.ts: a rollout that can still back out stops as
// soon as the signal lands (`beginShutdown`), one that has promoted its
// release gets the deadline to finish recreating, and a Docker command still
// running when it expires is stopped and collected before the process exits,
// all inside the updater's compose stop_grace_period.
setShutdownHandle(
	installShutdown({
		server,
		timeoutMs: SHUTDOWN_DEADLINE_MS,
		log,
		onShutdown: beginShutdown,
		exit: (code) => void exitAfterStoppingChildren(code),
	})
);

server.listen(PORT, '0.0.0.0', () => {
	console.info(`Updater sidecar listening on port ${PORT}`);
});
