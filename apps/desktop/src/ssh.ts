/**
 * SSH bridge — wraps the native `ssh_*` Tauri commands (implemented in Rust over
 * the `ssh2` crate) used by the "set up a new server" flow.
 *
 * The flow is: connect (TCP + handshake, no credentials) → show the host-key
 * fingerprint → accept → authenticate → run/upload over the live session →
 * disconnect. The live session lives in Rust state keyed by `sessionId`, so
 * credentials only ever cross this boundary once (at `sshAuthenticate`).
 */
import { invoke, Channel } from '@tauri-apps/api/core';

export interface ConnectInfo {
	sessionId: string;
	/** OpenSSH-style `SHA256:<base64>` host-key fingerprint. */
	fingerprint: string;
	hostKeyType: string;
	knownHostStatus: 'new' | 'match' | 'mismatch';
}

export type SshAuth =
	| { type: 'password'; password: string }
	/**
	 * Pasted key material, OR the key file the user chose with `sshPickKeyFile`.
	 * There is no path field: Rust reads only a file the user picked natively.
	 */
	| { type: 'key'; privateKey?: string; usePickedKeyFile?: boolean; passphrase?: string };

export type ExecEvent =
	| { kind: 'stdout'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number };

/**
 * Open the native picker to choose an SSH private key (starts in `~/.ssh`).
 * Rust remembers the choice for `sshAuthenticate` with `usePickedKeyFile`;
 * the returned path is for display. Null when the user cancelled.
 */
export function sshPickKeyFile(title?: string): Promise<string | null> {
	return invoke<string | null>('ssh_pick_key_file', { title });
}

/** TCP-connect + SSH-handshake only (no credentials sent). */
export function sshConnect(host: string, port?: number): Promise<ConnectInfo> {
	return invoke<ConnectInfo>('ssh_connect', { host, port });
}

/**
 * Persist the session's host key to known_hosts (user accepted the fingerprint).
 * `acceptChanged` must be true to (re)accept a key that has CHANGED since a prior
 * connection — the native side refuses a silent overwrite of a trusted key.
 */
export function sshAcceptHostKey(sessionId: string, acceptChanged?: boolean): Promise<void> {
	return invoke('ssh_accept_host_key', { sessionId, acceptChanged });
}

/** Authenticate the stored session with a password or private key. */
export function sshAuthenticate(sessionId: string, username: string, auth: SshAuth): Promise<void> {
	return invoke('ssh_authenticate', { sessionId, username, auth });
}

/** Run a command, streaming stdout/stderr line-by-line; resolves with the exit code. */
export function sshExecStream(
	sessionId: string,
	command: string,
	onEvent: (event: ExecEvent) => void
): Promise<number> {
	const channel = new Channel<ExecEvent>();
	channel.onmessage = onEvent;
	return invoke<number>('ssh_exec_stream', { sessionId, command, onEvent: channel });
}

/** Upload a small file to the server (mode defaults to 600). */
export function sshWriteFile(
	sessionId: string,
	path: string,
	content: string,
	mode?: string
): Promise<void> {
	return invoke('ssh_write_file', { sessionId, path, content, mode });
}

/**
 * A local image build for the push-images dev install path: the Compose stack
 * (named services and profiles of the checkout's docker-compose.yml) or the
 * setup-cli image, for the server's Docker platform (`linux/amd64` or
 * `linux/arm64`). The native side owns the rest of the `docker` invocation.
 */
export type LocalBuild =
	| { kind: 'stack'; platform: string; profiles: string[]; services: string[] }
	| { kind: 'setupImage'; platform: string };

// The three commands below are the local-source ("development") install paths.
// They exist only in developer builds of the app (the `dev-provisioning` Cargo
// feature, on for `tauri dev`); a release build rejects them as unknown.

/**
 * Upload a local directory tree into `remoteDir` as a streamed tar.gz
 * (.gitignore honoured, `.git` skipped). Used by the "local source" dev
 * install path instead of git-cloning the published repo. `localDir` must be
 * the absolute path of an Owlat checkout.
 */
export function sshUploadDir(
	sessionId: string,
	localDir: string,
	remoteDir: string
): Promise<void> {
	return invoke('ssh_upload_dir', { sessionId, localDir, remoteDir });
}

/**
 * Stream locally built images to the server over the live SSH session
 * (`docker save` → gzip → remote `docker load`). Progress and the load
 * output arrive as stdout events. Only local `:dev` images are accepted.
 */
export function sshPushImages(
	sessionId: string,
	images: string[],
	onEvent: (event: ExecEvent) => void
): Promise<void> {
	const channel = new Channel<ExecEvent>();
	channel.onmessage = onEvent;
	return invoke('ssh_push_images', { sessionId, images, onEvent: channel });
}

/**
 * Build images on THIS machine in the Owlat checkout at `localDir` (the
 * push-images dev install path), streaming output like sshExecStream;
 * resolves with docker's exit code. The build belongs to the session for the
 * server it targets: cancelling or disconnecting that session kills it.
 */
export function localDockerBuild(
	sessionId: string,
	localDir: string,
	build: LocalBuild,
	onEvent: (event: ExecEvent) => void
): Promise<number> {
	const channel = new Channel<ExecEvent>();
	channel.onmessage = onEvent;
	return invoke<number>('local_docker_build', { sessionId, localDir, build, onEvent: channel });
}

/**
 * Stop whatever is running on the session (an exec, an upload, a local build)
 * and keep the session for the commands that follow. The stopped call rejects
 * with "Cancelled.". A command already running on the server is not killed:
 * its pipes close, so it fails on its next write.
 */
export function sshCancel(sessionId: string): Promise<void> {
	return invoke('ssh_cancel', { sessionId });
}

/** Drop the session: stop what runs on it and close the connection. */
export function sshDisconnect(sessionId: string): Promise<void> {
	return invoke('ssh_disconnect', { sessionId });
}
