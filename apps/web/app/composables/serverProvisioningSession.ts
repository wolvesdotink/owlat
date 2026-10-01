/**
 * The end of a desktop provisioning session: removing the uploaded setup
 * config, and leaving the wizard while something may still be running.
 *
 * The setup config holds the admin password and every provider key in
 * plaintext. It is removed after every install that uploaded it, successful or
 * not, and when the wizard is left. The installer also deletes it itself when
 * its run ends (`OWLAT_CONSUME_CONFIG`, see `installerCommand`), which covers a
 * desktop that is killed before it can clean up.
 *
 * Split from `useServerProvisioning.ts` to keep that file under the size cap.
 * No Vue here: the composable owns the state and passes the transport in.
 */
import type { ProvisionTransport } from '~/lib/desktop/provisioning';
import { removeSetupConfigCommand } from '~/lib/desktop/provisioningForm';

/**
 * Thrown by the wizard's steps once it has been left, so a run that was in
 * flight stops where it is instead of starting the next installer step. It is
 * not a failure: nobody is looking at the wizard any more.
 */
export class ProvisioningAbandoned extends Error {
	constructor() {
		super('The server setup was left.');
		this.name = 'ProvisioningAbandoned';
	}
}

/**
 * How long leaving the wizard waits for the config removal. The removal queues
 * behind the cancelled step on the native side, which lets go of the session
 * within a second; a server that stopped answering must not hold the session
 * open forever.
 */
const LEAVE_CLEANUP_TIMEOUT_MS = 20_000;

/**
 * Delete the uploaded setup config over the session. Never throws: resolves
 * true when the server confirmed the removal (or there was nothing to remove),
 * false when it could not be confirmed.
 */
export async function removeUploadedConfig(
	ssh: ProvisionTransport,
	sessionId: string,
	installDir: string
): Promise<boolean> {
	try {
		const code = await ssh.execStream(sessionId, removeSetupConfigCommand(installDir), () => {});
		return code === 0;
	} catch {
		return false;
	}
}

/**
 * Leave a session: stop what is running on it (the native side kills local
 * builds and closes the remote command's channel), remove the setup config if
 * it may be on the server, then disconnect. Best-effort throughout; the
 * disconnect always happens.
 */
export async function leaveSession(
	ssh: ProvisionTransport,
	sessionId: string,
	opts: { running: boolean; configOnServer: boolean; installDir: string }
): Promise<void> {
	try {
		if (opts.running) await ssh.cancel(sessionId);
		if (opts.configOnServer) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				removeUploadedConfig(ssh, sessionId, opts.installDir),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, LEAVE_CLEANUP_TIMEOUT_MS);
				}),
			]);
			clearTimeout(timer);
		}
	} catch {
		// best-effort: the disconnect below still releases the session
	} finally {
		await ssh.disconnect(sessionId).catch(() => {});
	}
}
