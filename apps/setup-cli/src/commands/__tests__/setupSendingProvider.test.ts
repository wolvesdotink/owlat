import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The transport picker's credential prompts must refuse an empty value AT THE
 * PROMPT.
 *
 * A bare Enter is the reachable path: `password()` resolves `''`, the wizard
 * probes the provider with an empty bearer token, and — for Emailit, whose
 * validator redacts by splitting the failure text on the key — the operator was
 * handed `f[redacted]e[redacted]t…` instead of a failure they could act on.
 * Clack's `validate` never resolves the prompt on a rejected value, so this is
 * what keeps `''` out of the validator (and out of `.env`) entirely.
 *
 * The prompts are driven through the mocked module: `validate` is a plain
 * function on the options object, so the assertion is on the option the wizard
 * PASSED, not on a re-implementation of it.
 */

vi.mock('@clack/prompts', () => ({
	select: vi.fn(),
	password: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	group: vi.fn(),
	isCancel: vi.fn(() => false),
}));

vi.mock('../../lib/progress', () => ({
	validateWithSpinner: vi.fn(async () => true),
}));

import { password, select } from '@clack/prompts';
import { pickSendingProvider } from '../setupSendingProvider';

type Validate = (value: string | undefined) => string | Error | undefined;

const selectMock = vi.mocked(select);
const passwordMock = vi.mocked(password);

beforeEach(() => {
	vi.clearAllMocks();
});

describe('pickSendingProvider — credential prompts', () => {
	it('rejects an empty Emailit API key at the prompt', async () => {
		selectMock.mockResolvedValue('emailit' as never);
		passwordMock.mockResolvedValue('em_live_key' as never);

		await expect(pickSendingProvider()).resolves.toEqual({
			EMAIL_PROVIDER: 'emailit',
			EMAILIT_API_KEY: 'em_live_key',
		});

		const options = passwordMock.mock.calls[0]?.[0] as { validate?: Validate };
		expect(options.validate).toBeTypeOf('function');
		expect(options.validate?.('')).toBeTruthy();
		expect(options.validate?.('   ')).toBeTruthy();
		expect(options.validate?.(undefined)).toBeTruthy();
		expect(options.validate?.('em_live_key')).toBeUndefined();
	});
});
