/**
 * A named pipe a stub command writes one line to once it reaches the point a
 * test waits for (the setup container running, a docker call blocked). The
 * test awaits that line instead of polling for a marker file: the write blocks
 * until the test reads, so the stub cannot run past the point unobserved.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface ReadinessPipe {
	readonly path: string;
	/**
	 * Resolves once the stub has written to the pipe. Rejects with `explain()`
	 * when `exited` settles first: the command ended without reaching the point.
	 */
	reached(exited: Promise<unknown>, explain: () => string): Promise<void>;
}

export function readinessPipe(path: string): ReadinessPipe {
	execFileSync('mkfifo', [path]);
	// Opening for read waits for the stub to open it for write; the read ends
	// when the stub closes it.
	const written = readFile(path, 'utf8').then(() => 'reached' as const);
	return {
		path,
		async reached(exited, explain) {
			const outcome = await Promise.race([written, exited.then(() => 'exited' as const)]);
			if (outcome === 'reached') return;
			// Give a still-waiting reader an end-of-file, so no open stays blocked.
			// ENXIO: the reader is done already.
			try {
				closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
			} catch {}
			await written;
			throw new Error(explain());
		},
	};
}
