/**
 * Shared per-IP connection-slot reconciliation (used by BOTH the MX/bounce and
 * submission listeners). The tracker reconciles the per-IP counter's increments
 * against socket lifetime: `checkConnectionRateLimit` is async, so a connection
 * can close (immediate-RST connects — port scans / LB health probes) while its
 * rate-limit round-trip is still pending. Every KEPT increment must be released
 * EXACTLY once, in whichever order the socket-close and the slot-held callback
 * fire — and a connection that never took a slot must never decrement.
 *
 * These cases are parametrized over BOTH concrete release functions the two
 * listeners inject (`inboundSecurity.releaseConnection` for the bounce listener,
 * `submissionSecurity.releaseConnection` for submission) so the shared module —
 * and thereby the bounce listener's new usage — is covered against each real
 * Redis-counter key prefix.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { createSlotTracker, type SlotPeer, type ReleaseSlot } from '../connectionSlots.js';
import { releaseConnection as releaseInbound } from '../../bounce/inboundSecurity.js';
import { releaseConnection as releaseSubmission } from '../../smtp/submissionSecurity.js';

// Let the async release (decr + possibly del) settle.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function fakeSocket(remoteAddress: string, remotePort: number): Socket {
	const sock = new EventEmitter() as unknown as Socket;
	(sock as { remoteAddress?: string }).remoteAddress = remoteAddress;
	(sock as { remotePort?: number }).remotePort = remotePort;
	return sock;
}
const peer = (remoteAddress: string, remotePort: number): SlotPeer => ({
	remoteAddress,
	remotePort,
});

interface ListenerVariant {
	readonly name: string;
	readonly release: ReleaseSlot;
	readonly connKey: (ip: string) => string;
}

const variants: readonly ListenerVariant[] = [
	{ name: 'bounce', release: releaseInbound, connKey: (ip) => `mta:bounce:conn:${ip}` },
	{ name: 'submission', release: releaseSubmission, connKey: (ip) => `mta:submission:conn:${ip}` },
];

describe.each(variants)('slot tracker reconciliation ($name listener)', ({ release, connKey }) => {
	it('releases a held slot exactly once when the socket closes after hold()', async () => {
		const r = new Redis() as unknown as RealRedis;
		const tracker = createSlotTracker(r, release);
		const sock = fakeSocket('7.7.7.7', 2001);
		tracker.track(sock); // TCP accept — live
		await r.incr(connKey('7.7.7.7')); // onConnect kept a slot (net +1)
		tracker.hold(peer('7.7.7.7', 2001)); // still live → mark for release on close
		expect(await r.get(connKey('7.7.7.7'))).toBe('1'); // not released yet
		sock.emit('close');
		await flush();
		expect(await r.get(connKey('7.7.7.7'))).toBeNull(); // released, key cleaned up
	});

	it('self-heals the race: a connection that closes BEFORE hold() still releases its slot', async () => {
		const r = new Redis() as unknown as RealRedis;
		const tracker = createSlotTracker(r, release);
		const sock = fakeSocket('6.6.6.6', 3003);
		tracker.track(sock); // accept — live
		await r.incr(connKey('6.6.6.6')); // rate-limit check kept the increment (in flight)
		sock.emit('close'); // client RST before hold(): live deleted, held miss → no release
		await flush();
		expect(await r.get(connKey('6.6.6.6'))).toBe('1'); // the leak-prone window
		tracker.hold(peer('6.6.6.6', 3003)); // reconciles: no longer live → release now
		await flush();
		expect(await r.get(connKey('6.6.6.6'))).toBeNull(); // released exactly once
	});

	it('never releases a slot for a connection that never took one', async () => {
		const r = new Redis() as unknown as RealRedis;
		const tracker = createSlotTracker(r, release);
		const sock = fakeSocket('5.5.5.5', 4004);
		tracker.track(sock);
		await r.incr(connKey('5.5.5.5')); // a different connection's live slot
		sock.emit('close'); // this socket never called hold() → must not decrement
		await flush();
		expect(await r.get(connKey('5.5.5.5'))).toBe('1'); // untouched
	});
});
