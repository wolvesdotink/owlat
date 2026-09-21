import { describe, expect, it } from 'vitest';
import { createAdminConvexClient } from '../convexAdminClient';

class FakeHttpClient {
	adminKey: string | null = null;
	constructor(readonly url: string) {}
	setAdminAuth(adminKey: string): void {
		this.adminKey = adminKey;
	}
}

describe('createAdminConvexClient', () => {
	it('constructs the client for the URL and authenticates it with the admin key', () => {
		const client = createAdminConvexClient(FakeHttpClient, 'https://convex.example', 'key-1');
		expect(client).toBeInstanceOf(FakeHttpClient);
		expect(client.url).toBe('https://convex.example');
		expect(client.adminKey).toBe('key-1');
	});
});
