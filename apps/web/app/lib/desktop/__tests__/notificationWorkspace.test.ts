import { describe, it, expect } from 'vitest';
import {
	PENDING_ACTION_FRESH_MS,
	PENDING_NOTIFICATION_ACTION_KEY,
	resolveNotificationWorkspace,
	takePendingAction,
	writePendingAction,
} from '../notificationWorkspace';

function memoryStorage(overrides: Partial<Storage> = {}): Storage {
	const data = new Map<string, string>();
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k: string) => data.get(k) ?? null,
		key: (i: number) => [...data.keys()][i] ?? null,
		removeItem: (k: string) => void data.delete(k),
		setItem: (k: string, v: string) => void data.set(k, v),
		...overrides,
	};
}

describe('resolveNotificationWorkspace', () => {
	const exists = (id: string) => id === 'ws-a' || id === 'ws-b';

	it('runs here when the notification came from the active workspace', () => {
		expect(resolveNotificationWorkspace('ws-a', 'ws-a', exists)).toEqual({ kind: 'here' });
	});

	it('runs here when the payload names no workspace', () => {
		expect(resolveNotificationWorkspace(undefined, 'ws-a', exists)).toEqual({ kind: 'here' });
		expect(resolveNotificationWorkspace('', 'ws-a', exists)).toEqual({ kind: 'here' });
		expect(resolveNotificationWorkspace(42, 'ws-a', exists)).toEqual({ kind: 'here' });
	});

	it('switches to another connected workspace', () => {
		expect(resolveNotificationWorkspace('ws-b', 'ws-a', exists)).toEqual({
			kind: 'switch',
			workspaceId: 'ws-b',
		});
	});

	it('reports a workspace that is no longer connected', () => {
		expect(resolveNotificationWorkspace('ws-gone', 'ws-a', exists)).toEqual({
			kind: 'gone',
			workspaceId: 'ws-gone',
		});
	});
});

describe('pending notification action', () => {
	const payload = { action: 'reply', messageId: 'm1', reply: 'hi' };

	it('round-trips for its own workspace, once', () => {
		const storage = memoryStorage();
		expect(writePendingAction(storage, 'ws-a', payload, 1000)).toBe(true);

		expect(takePendingAction(storage, 'ws-a', 1000 + PENDING_ACTION_FRESH_MS)).toEqual({
			payload,
			fresh: true,
		});
		expect(takePendingAction(storage, 'ws-a', 1000)).toBeNull();
	});

	it('is stale past the window, and when the clock went backwards', () => {
		const storage = memoryStorage();
		writePendingAction(storage, 'ws-a', payload, 1000);
		expect(takePendingAction(storage, 'ws-a', 1001 + PENDING_ACTION_FRESH_MS)?.fresh).toBe(false);

		writePendingAction(storage, 'ws-a', payload, 1000);
		expect(takePendingAction(storage, 'ws-a', 999)?.fresh).toBe(false);
	});

	it('is left alone for another workspace or none', () => {
		const storage = memoryStorage();
		writePendingAction(storage, 'ws-a', payload, 1000);
		expect(takePendingAction(storage, 'ws-b', 1000)).toBeNull();
		expect(takePendingAction(storage, null, 1000)).toBeNull();
		expect(storage.getItem(PENDING_NOTIFICATION_ACTION_KEY)).not.toBeNull();
	});

	it('reports a failed write', () => {
		const storage = memoryStorage({
			setItem: () => {
				throw new Error('quota');
			},
		});
		expect(writePendingAction(storage, 'ws-a', payload, 1000)).toBe(false);
	});

	it('drops an entry it cannot remove rather than replaying it', () => {
		const storage = memoryStorage({
			removeItem: () => {
				throw new Error('denied');
			},
		});
		writePendingAction(storage, 'ws-a', payload, 1000);
		expect(takePendingAction(storage, 'ws-a', 1000)).toBeNull();
	});

	it('ignores corrupted entries', () => {
		const storage = memoryStorage();
		for (const raw of ['{', 'null', '"x"', '{"workspaceId":"ws-a","payload":{}}']) {
			storage.setItem(PENDING_NOTIFICATION_ACTION_KEY, raw);
			expect(takePendingAction(storage, 'ws-a', 1000)).toBeNull();
		}
		storage.setItem(
			PENDING_NOTIFICATION_ACTION_KEY,
			JSON.stringify({ workspaceId: 'ws-a', at: 1000, payload: 'nope' })
		);
		expect(takePendingAction(storage, 'ws-a', 1000)).toBeNull();
	});

	it('survives a storage that throws on read', () => {
		const storage = memoryStorage({
			getItem: () => {
				throw new Error('denied');
			},
		});
		expect(takePendingAction(storage, 'ws-a', 1000)).toBeNull();
	});
});
