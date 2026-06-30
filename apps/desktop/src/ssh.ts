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
	/** Pasted key material OR a path to a key file on this machine (`~` expanded in Rust). */
	| { type: 'key'; privateKey?: string; privateKeyPath?: string; passphrase?: string };

export type ExecEvent =
	| { kind: 'stdout'; line: string }
	| { kind: 'stderr'; line: string }
	| { kind: 'exit'; code: number };

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
	onEvent: (event: ExecEvent) => void,
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
	mode?: string,
): Promise<void> {
	return invoke('ssh_write_file', { sessionId, path, content, mode });
}

/**
 * Upload a local directory tree into `remoteDir` as a streamed tar.gz
 * (.gitignore honoured, `.git` skipped). Used by the "local source" dev
 * install path instead of git-cloning the published repo.
 */
export function sshUploadDir(sessionId: string, localDir: string, remoteDir: string): Promise<void> {
	return invoke('ssh_upload_dir', { sessionId, localDir, remoteDir });
}

/**
 * Stream locally built images to the server over the live SSH session
 * (`docker save` → gzip → remote `docker load`). Progress and the load
 * output arrive as stdout events.
 */
export function sshPushImages(
	sessionId: string,
	images: string[],
	onEvent: (event: ExecEvent) => void,
): Promise<void> {
	const channel = new Channel<ExecEvent>();
	channel.onmessage = onEvent;
	return invoke('ssh_push_images', { sessionId, images, onEvent: channel });
}

/**
 * Run a LOCAL process (e.g. `docker compose build` on this machine for the
 * push-images dev install path), streaming output like sshExecStream.
 */
export function localExecStream(
	program: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
	onEvent: (event: ExecEvent) => void,
): Promise<number> {
	const channel = new Channel<ExecEvent>();
	channel.onmessage = onEvent;
	return invoke<number>('local_exec_stream', { program, args, cwd, env, onEvent: channel });
}

/** Drop the session (closes the connection). */
export function sshDisconnect(sessionId: string): Promise<void> {
	return invoke('ssh_disconnect', { sessionId });
}
