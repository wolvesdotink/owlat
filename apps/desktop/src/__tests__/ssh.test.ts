import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri core bridge: invoke is a spy, Channel is a minimal stand-in
// whose onmessage we can drive to simulate streamed exec events. invokeMock is
// declared via vi.hoisted so it exists when the hoisted vi.mock factory runs.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
	Channel: class {
		onmessage: ((msg: unknown) => void) | null = null;
	},
}));

import {
	sshConnect,
	sshAcceptHostKey,
	sshAuthenticate,
	sshExecStream,
	sshWriteFile,
	sshDisconnect,
	type ExecEvent,
} from '../ssh';

beforeEach(() => {
	invokeMock.mockReset();
});

describe('ssh bridge', () => {
	it('sshConnect invokes ssh_connect and returns the connect info', async () => {
		const info = {
			sessionId: 's1',
			fingerprint: 'SHA256:abc',
			hostKeyType: 'ssh-ed25519',
			knownHostStatus: 'new' as const,
		};
		invokeMock.mockResolvedValue(info);

		const result = await sshConnect('example.com', 22);

		expect(invokeMock).toHaveBeenCalledWith('ssh_connect', { host: 'example.com', port: 22 });
		expect(result).toEqual(info);
	});

	it('sshConnect passes an undefined port through (Rust default)', async () => {
		invokeMock.mockResolvedValue({});
		await sshConnect('host.local');
		expect(invokeMock).toHaveBeenCalledWith('ssh_connect', { host: 'host.local', port: undefined });
	});

	it('sshAcceptHostKey invokes ssh_accept_host_key with the session id', async () => {
		invokeMock.mockResolvedValue(undefined);
		await sshAcceptHostKey('s1');
		expect(invokeMock).toHaveBeenCalledWith('ssh_accept_host_key', { sessionId: 's1', acceptChanged: undefined });
	});

	it('sshAcceptHostKey forwards acceptChanged when re-accepting a changed key', async () => {
		invokeMock.mockResolvedValue(undefined);
		await sshAcceptHostKey('s1', true);
		expect(invokeMock).toHaveBeenCalledWith('ssh_accept_host_key', { sessionId: 's1', acceptChanged: true });
	});

	it('sshAuthenticate forwards a password credential exactly once', async () => {
		invokeMock.mockResolvedValue(undefined);
		const auth = { type: 'password', password: 'hunter2' } as const;

		await sshAuthenticate('s1', 'root', auth);

		expect(invokeMock).toHaveBeenCalledOnce();
		expect(invokeMock).toHaveBeenCalledWith('ssh_authenticate', {
			sessionId: 's1',
			username: 'root',
			auth,
		});
	});

	it('sshAuthenticate forwards a private-key credential', async () => {
		invokeMock.mockResolvedValue(undefined);
		const auth = { type: 'key', privateKey: '-----BEGIN-----', passphrase: 'p' } as const;

		await sshAuthenticate('s1', 'deploy', auth);

		expect(invokeMock).toHaveBeenCalledWith('ssh_authenticate', {
			sessionId: 's1',
			username: 'deploy',
			auth,
		});
	});

	it('sshExecStream wires the channel to onEvent and resolves with the exit code', async () => {
		invokeMock.mockResolvedValue(0);
		const events: ExecEvent[] = [];

		const promise = sshExecStream('s1', 'ls -la', (e) => events.push(e));

		const [cmd, args] = invokeMock.mock.calls[0]!;
		expect(cmd).toBe('ssh_exec_stream');
		expect(args.sessionId).toBe('s1');
		expect(args.command).toBe('ls -la');

		// Simulate the Rust side streaming events through the channel.
		args.onEvent.onmessage({ kind: 'stdout', line: 'total 0' });
		args.onEvent.onmessage({ kind: 'exit', code: 0 });
		expect(events).toEqual([
			{ kind: 'stdout', line: 'total 0' },
			{ kind: 'exit', code: 0 },
		]);

		expect(await promise).toBe(0);
	});

	it('sshWriteFile invokes ssh_write_file with the mode', async () => {
		invokeMock.mockResolvedValue(undefined);
		await sshWriteFile('s1', '/etc/owlat/.env', 'KEY=val', '600');
		expect(invokeMock).toHaveBeenCalledWith('ssh_write_file', {
			sessionId: 's1',
			path: '/etc/owlat/.env',
			content: 'KEY=val',
			mode: '600',
		});
	});

	it('sshDisconnect invokes ssh_disconnect', async () => {
		invokeMock.mockResolvedValue(undefined);
		await sshDisconnect('s1');
		expect(invokeMock).toHaveBeenCalledWith('ssh_disconnect', { sessionId: 's1' });
	});

	it('propagates a rejected invoke (e.g. auth failure)', async () => {
		invokeMock.mockRejectedValue(new Error('Authentication failed'));
		await expect(sshAuthenticate('s1', 'root', { type: 'password', password: 'bad' })).rejects.toThrow(
			/Authentication failed/
		);
	});
});
