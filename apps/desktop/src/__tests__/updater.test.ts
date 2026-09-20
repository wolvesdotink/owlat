import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri IPC surface: `invoke` is a spy, `Channel` a stand-in whose
// `onmessage` the fake command drives so progress events can be asserted.
// Hoisted so the spies exist when the factory runs.
const { invokeMock, listenMock, FakeChannel } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	listenMock: vi.fn(),
	FakeChannel: class {
		onmessage: ((event: unknown) => void) | null = null;
	},
}));
type FakeChannel = InstanceType<typeof FakeChannel>;

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
	Channel: FakeChannel,
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: (...args: unknown[]) => listenMock(...args),
}));

import {
	buildUpdateEndpoint,
	checkForUpdate,
	installUpdate,
	notifyUpdateReady,
	onUpdateRestartRequest,
	restartApp,
	toUpdateError,
	UpdateError,
	type UpdateProgress,
} from '../updater';

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	invokeMock.mockResolvedValue(null);
});

describe('buildUpdateEndpoint', () => {
	it('builds the manifest route with the placeholders the updater substitutes', () => {
		expect(buildUpdateEndpoint('https://acme.example')).toBe(
			'https://acme.example/api/desktop/update/{{target}}/{{arch}}/{{current_version}}'
		);
	});

	it('uses only the origin, so a stored path or trailing slash cannot leak in', () => {
		expect(buildUpdateEndpoint('https://acme.example:8443/dashboard/settings')).toBe(
			'https://acme.example:8443/api/desktop/update/{{target}}/{{arch}}/{{current_version}}'
		);
	});
});

describe('checkForUpdate', () => {
	it('passes the endpoint through and maps a found update', async () => {
		invokeMock.mockResolvedValue({ version: '0.4.7', notes: 'Fixes things', date: 1 });

		await expect(checkForUpdate('https://acme.example/api/desktop/update/a/b/c')).resolves.toEqual({
			version: '0.4.7',
			notes: 'Fixes things',
		});
		expect(invokeMock).toHaveBeenCalledWith('updater_check', {
			endpoint: 'https://acme.example/api/desktop/update/a/b/c',
		});
	});

	it('sends a null endpoint for the GitHub fallback and reports "nothing to install"', async () => {
		invokeMock.mockResolvedValue(null);

		await expect(checkForUpdate(null)).resolves.toBeNull();
		expect(invokeMock).toHaveBeenCalledWith('updater_check', { endpoint: null });
	});

	it('omits notes the manifest did not carry', async () => {
		invokeMock.mockResolvedValue({ version: '0.4.7', notes: null });
		await expect(checkForUpdate(null)).resolves.toEqual({ version: '0.4.7' });
	});

	it('rejects with the kind Rust classified, not a swallowed console warning', async () => {
		invokeMock.mockRejectedValue('network: error sending request');

		// The whole point of the typed error: a flaky network stays quiet, a
		// signature failure does not.
		await expect(checkForUpdate(null)).rejects.toMatchObject({
			error: 'network',
			message: 'error sending request',
		});
	});
});

describe('installUpdate', () => {
	it('streams started / progress / finished over the channel', async () => {
		const seen: UpdateProgress[] = [];
		invokeMock.mockImplementation(async (_cmd: string, args: { onEvent: FakeChannel }) => {
			args.onEvent.onmessage?.({ kind: 'started', contentLength: 100 });
			args.onEvent.onmessage?.({ kind: 'progress', chunkLength: 40 });
			args.onEvent.onmessage?.({ kind: 'finished' });
			return null;
		});

		await installUpdate((event) => seen.push(event));

		expect(seen).toEqual([
			{ kind: 'started', contentLength: 100 },
			{ kind: 'progress', chunkLength: 40 },
			{ kind: 'finished' },
		]);
	});

	it('surfaces a signature failure as such', async () => {
		invokeMock.mockRejectedValue('signature: minisign verification failed');

		await expect(installUpdate(() => {})).rejects.toMatchObject({ error: 'signature' });
	});
});

describe('restartApp', () => {
	it('invokes the restart command', async () => {
		await restartApp();
		expect(invokeMock).toHaveBeenCalledWith('updater_restart');
	});
});

describe('notifyUpdateReady', () => {
	it('passes the translated strings to the native notification', async () => {
		await expect(notifyUpdateReady('Update ready', 'Owlat 0.4.7', 'Restart now')).resolves.toBe(
			true
		);
		expect(invokeMock).toHaveBeenCalledWith('updater_notify_ready', {
			title: 'Update ready',
			body: 'Owlat 0.4.7',
			actionLabel: 'Restart now',
		});
	});

	it('reports false (never throws) when the shell has no such command', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		invokeMock.mockRejectedValue(new Error('command not found'));

		await expect(notifyUpdateReady('t', 'b', 'r')).resolves.toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('onUpdateRestartRequest', () => {
	it('fires only for the restart action', async () => {
		type EventHandler = (e: { payload: { action: string } }) => void;
		const handlers: EventHandler[] = [];
		const unlisten = vi.fn();
		listenMock.mockImplementation(async (_event: string, handler: EventHandler) => {
			handlers.push(handler);
			return unlisten;
		});
		const cb = vi.fn();

		await expect(onUpdateRestartRequest(cb)).resolves.toBe(unlisten);
		expect(listenMock).toHaveBeenCalledWith('updater-action', expect.any(Function));

		handlers[0]?.({ payload: { action: 'something-else' } });
		expect(cb).not.toHaveBeenCalled();
		handlers[0]?.({ payload: { action: 'restart' } });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it('returns null when the event bridge is unavailable', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		listenMock.mockRejectedValue(new Error('no tauri'));

		await expect(onUpdateRestartRequest(() => {})).resolves.toBeNull();
		warn.mockRestore();
	});
});

describe('toUpdateError', () => {
	it('splits the kind Rust prefixed onto the message', () => {
		const err = toUpdateError('signature: bad trusted comment');
		expect(err).toBeInstanceOf(UpdateError);
		expect(err.error).toBe('signature');
		expect(err.message).toBe('bad trusted comment');
	});

	it('keeps an unrecognized prefix as part of the message', () => {
		// A colon in a plain message must not be read as a kind.
		const err = toUpdateError('IO error: permission denied');
		expect(err.error).toBe('unknown');
		expect(err.message).toBe('IO error: permission denied');
	});

	it('handles a thrown Error and a non-string alike', () => {
		expect(toUpdateError(new Error('network: down')).error).toBe('network');
		expect(toUpdateError(undefined).message).toBe('undefined');
	});
});
