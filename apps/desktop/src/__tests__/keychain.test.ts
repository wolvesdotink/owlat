import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

import { onSessionReplaced, sessionRead, sessionReplace, sessionWrite } from '../keychain';

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('session keychain bridge', () => {
	it('writes against a revision and reports a refused write as stale', async () => {
		invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(sessionWrite('owlat-ws:a', '{}', 2)).resolves.toBe('written');
		await expect(sessionWrite('owlat-ws:a', '{}', 2)).resolves.toBe('stale');
		expect(invokeMock).toHaveBeenCalledWith('session_secret_write', {
			account: 'owlat-ws:a',
			value: '{}',
			revision: 2,
		});
	});

	it('reports a keychain failure apart from a stale write', async () => {
		invokeMock.mockRejectedValueOnce(new Error('locked'));
		await expect(sessionWrite('owlat-ws:a', '{}', 0)).resolves.toBe('failed');
	});

	it('reads null when the keychain cannot be read', async () => {
		invokeMock.mockResolvedValueOnce({ value: 'blob', revision: 1 });
		await expect(sessionRead('owlat-ws:a')).resolves.toEqual({ value: 'blob', revision: 1 });
		invokeMock.mockRejectedValueOnce(new Error('locked'));
		await expect(sessionRead('owlat-ws:a')).resolves.toBeNull();
	});

	// The connect handshake must not record a workspace whose session never
	// reached the keychain, so a refused replace rejects.
	it('rejects a replace the keychain refused', async () => {
		invokeMock.mockResolvedValueOnce(3);
		await expect(sessionReplace('owlat-ws:a', null)).resolves.toBe(3);
		expect(invokeMock).toHaveBeenCalledWith('session_secret_replace', {
			account: 'owlat-ws:a',
			value: null,
		});
		invokeMock.mockRejectedValueOnce(new Error('locked'));
		await expect(sessionReplace('owlat-ws:a', 'blob')).rejects.toThrow('locked');
	});

	it('hands the replaced account and revision to the listener', async () => {
		const cb = vi.fn();
		listenMock.mockImplementation(async (_event: string, handler: (e: unknown) => void) => {
			handler({ payload: { account: 'owlat-ws:a', revision: 4 } });
			return () => {};
		});
		await onSessionReplaced(cb);
		expect(listenMock).toHaveBeenCalledWith('session-secret-replaced', expect.any(Function));
		expect(cb).toHaveBeenCalledWith('owlat-ws:a', 4);
	});
});
