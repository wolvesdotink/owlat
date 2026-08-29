import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock DNS resolution so the re-check sees a public name pointing at an internal
// address (public-name → internal-IP), without touching the network.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	lookup: (...args: unknown[]) => lookupMock(...args),
}));

// Guard: if a blocked host ever reaches the actual probe, this mock records it —
// the test asserts it is NEVER called for an internal-resolving host.
const fetchProviderMock = vi.fn();
vi.mock('../setupValidationHttp', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../setupValidationHttp')>();
	return { ...actual, fetchSetupProvider: (...args: unknown[]) => fetchProviderMock(...args) };
});

import { validatePostHogHost } from '../setupValidators';

afterEach(() => {
	vi.clearAllMocks();
});

describe('validatePostHogHost SSRF DNS re-check', () => {
	it('blocks a public hostname that resolves to a private address, before any probe', async () => {
		lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

		await expect(validatePostHogHost('https://rebind.example.com')).resolves.toEqual({
			ok: false,
			message: 'PostHog host must be a public address.',
		});
		// Fail closed: the probe must never fire at an internal-resolving host.
		expect(fetchProviderMock).not.toHaveBeenCalled();
	});

	it('blocks a public hostname resolving to the cloud-metadata address', async () => {
		lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

		await expect(validatePostHogHost('metadata.attacker.example')).resolves.toEqual({
			ok: false,
			message: 'PostHog host must be a public address.',
		});
		expect(fetchProviderMock).not.toHaveBeenCalled();
	});

	it('allows a genuinely public host (resolves to a public address) through to the probe', async () => {
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		fetchProviderMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await expect(validatePostHogHost('https://app.posthog.com')).resolves.toEqual({
			ok: true,
			message: 'PostHog host reachable.',
		});
		expect(fetchProviderMock).toHaveBeenCalledTimes(1);
	});

	it('does not reject on a transient DNS failure (best-effort, non-breaking)', async () => {
		lookupMock.mockRejectedValue(new Error('EAI_AGAIN'));
		fetchProviderMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await expect(validatePostHogHost('https://app.posthog.com')).resolves.toEqual({
			ok: true,
			message: 'PostHog host reachable.',
		});
	});
});
