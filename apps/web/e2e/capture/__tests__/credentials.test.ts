/**
 * Which account `bun run capture` signs in as: the seeded owner, admin or
 * member from `bun run dev:seed`, or nobody for a signed-out pair.
 */
import { describe, expect, it } from 'vitest';
import { captureCredentials } from '../options';

describe('captureCredentials', () => {
	it('signs in as the seeded account the pair names, or not at all', () => {
		expect(captureCredentials({}, 'owner')?.email).toBe('dev@example.com');
		expect(captureCredentials({}, 'admin')?.email).toBe('taylor@example.com');
		expect(captureCredentials({}, 'member')?.email).toBe('jordan@example.com');
		expect(captureCredentials({}, 'signed-out')).toBeNull();
	});

	it('lets OWLAT_CAPTURE_EMAIL and OWLAT_CAPTURE_PASSWORD replace only the owner', () => {
		const env = { OWLAT_CAPTURE_EMAIL: 'owner@owlat.example', OWLAT_CAPTURE_PASSWORD: 'secret' };
		expect(captureCredentials(env, 'owner')).toEqual({
			email: 'owner@owlat.example',
			password: 'secret',
		});
		expect(captureCredentials(env, 'member')?.email).toBe('jordan@example.com');
	});
});
