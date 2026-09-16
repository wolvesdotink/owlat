import { describe, it, expect } from 'vitest';
import {
	PENDING_CONNECTIONS_KEY,
	PENDING_CONNECTION_TTL_MS,
	clearPendingConnections,
	readPendingConnections,
	takePendingConnection,
	writePendingConnection,
	type PendingStorage,
} from '../pendingConnections';
import type { InstanceInfo } from '../workspaceTypes';

const info: InstanceInfo = {
	name: 'acme',
	convexUrl: 'https://api.acme.test',
	convexSiteUrl: 'https://rest.api.acme.test',
	siteUrl: 'https://acme.test',
	deploymentMode: 'selfhost',
};

function fakeStorage(seed: Record<string, string> = {}): PendingStorage & { raw: () => string } {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
		raw: () => map.get(PENDING_CONNECTIONS_KEY) ?? '',
	};
}

describe('pendingConnections', () => {
	// The whole point of this module: the process that completes a cold-start
	// handshake is NOT the one that started it (macOS launches the app to
	// deliver owlat://auth), so the state nonce must resolve from storage, not
	// from a Map that the new process never populated.
	it('resolves a handshake written by a previous process', () => {
		const disk = fakeStorage();
		writePendingConnection(disk, 'nonce-1', { id: 'ws-1', info, at: 1_000 });

		// A brand-new process reading the same durable storage.
		const relaunched = fakeStorage({ [PENDING_CONNECTIONS_KEY]: disk.raw() });
		expect(takePendingConnection(relaunched, 'nonce-1', 2_000)).toMatchObject({ id: 'ws-1' });
	});

	it('consumes a handshake so a replayed deep link cannot redeem twice', () => {
		const s = fakeStorage();
		writePendingConnection(s, 'nonce-1', { id: 'ws-1', info, at: 1_000 });

		expect(takePendingConnection(s, 'nonce-1', 1_500)).not.toBeNull();
		expect(takePendingConnection(s, 'nonce-1', 1_500)).toBeNull();
	});

	it('expires handshakes past the TTL', () => {
		const s = fakeStorage();
		writePendingConnection(s, 'nonce-1', { id: 'ws-1', info, at: 1_000 });

		expect(takePendingConnection(s, 'nonce-1', 1_000 + PENDING_CONNECTION_TTL_MS)).toBeNull();
	});

	it('keeps concurrent handshakes independent', () => {
		const s = fakeStorage();
		writePendingConnection(s, 'a', { id: 'ws-a', info, at: 1_000 });
		writePendingConnection(s, 'b', { id: 'ws-b', info, at: 1_000 });

		expect(takePendingConnection(s, 'a', 1_100)?.id).toBe('ws-a');
		expect(takePendingConnection(s, 'b', 1_100)?.id).toBe('ws-b');
	});

	it('prunes expired siblings when writing', () => {
		const s = fakeStorage();
		writePendingConnection(s, 'old', { id: 'ws-old', info, at: 0 });
		writePendingConnection(s, 'new', { id: 'ws-new', info, at: PENDING_CONNECTION_TTL_MS + 1 });

		expect(Object.keys(readPendingConnections(s, PENDING_CONNECTION_TTL_MS + 1))).toEqual(['new']);
	});

	it('reads corrupt or malformed storage as empty instead of throwing', () => {
		expect(readPendingConnections(fakeStorage({ [PENDING_CONNECTIONS_KEY]: '{' }), 0)).toEqual({});
		expect(
			readPendingConnections(fakeStorage({ [PENDING_CONNECTIONS_KEY]: '{"a":{"id":1}}' }), 0)
		).toEqual({});
	});

	it('survives a storage that throws (blocked/full)', () => {
		const hostile: PendingStorage = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			},
		};
		expect(() => writePendingConnection(hostile, 'a', { id: 'x', info, at: 0 })).not.toThrow();
		expect(readPendingConnections(hostile, 0)).toEqual({});
		expect(takePendingConnection(hostile, 'a', 0)).toBeNull();
		expect(() => clearPendingConnections(hostile)).not.toThrow();
	});
});
