import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The wizard's one decision-plane question.
 *
 * Three things are asserted rather than trusted, because each of them is the
 * difference between a recommendation and a default anyone is pushed into. The
 * question PRE-FILLS the recommended adapter (what we would choose) while
 * keeping SKIP as the first option in the list (the answer that changes
 * nothing, always on top); skipping writes nothing at all; and a bare Enter on
 * the key prompt is read as a skip instead of putting an empty credential in
 * `.env`, where it would read as a provider outage. Choosing the recommendation
 * still costs the operator a key of their own — the wizard cannot enable the
 * plane on its own, and nothing leaves a deployment without one.
 */

vi.mock('@clack/prompts', () => ({
	log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
	isCancel: vi.fn(() => false),
	select: vi.fn(),
	text: vi.fn(),
	password: vi.fn(),
	group: vi.fn(),
}));

import { isCancel, password, select } from '@clack/prompts';
import { pickDecisionProvider } from '../setupAiProvider';
import { SETUP_DEFAULT_DECISION_KIND } from '../../lib/setupEnvDefaults';

const selectMock = vi.mocked(select);
const passwordMock = vi.mocked(password);
const isCancelMock = vi.mocked(isCancel);

beforeEach(() => {
	vi.clearAllMocks();
	isCancelMock.mockReturnValue(false);
});

describe('pickDecisionProvider', () => {
	it('offers skip first and pre-fills the recommended adapter', async () => {
		selectMock.mockResolvedValueOnce('skip' as never);
		await pickDecisionProvider();

		const options = selectMock.mock.calls[0]![0] as {
			initialValue?: string;
			options: { value: string }[];
		};
		// The pre-filled answer is the shared constant, not a literal: the web
		// card reads the same one, and the two surfaces describe one answer.
		expect(options.initialValue).toBe(SETUP_DEFAULT_DECISION_KIND);
		expect(options.options[0]!.value).toBe('skip');
		expect(options.options.map((option) => option.value)).toEqual(['skip', 'typesafe']);
	});

	it('writes nothing and asks for no key when skipped', async () => {
		selectMock.mockResolvedValueOnce('skip' as never);

		const result = await pickDecisionProvider();

		expect(result).toEqual({ env: {}, isPlaneConfigured: false });
		expect(passwordMock).not.toHaveBeenCalled();
	});

	it('names the adapter and carries the key when one is entered', async () => {
		selectMock.mockResolvedValueOnce('typesafe' as never);
		passwordMock.mockResolvedValueOnce('placeholder-not-a-real-key' as never);

		const result = await pickDecisionProvider();

		expect(result).toEqual({
			env: {
				DECISION_PROVIDER: 'typesafe',
				TYPESAFE_API_KEY: 'placeholder-not-a-real-key',
			},
			isPlaneConfigured: true,
		});
	});

	it.each(['', '   ', '\t'])('reads an empty key %j as a skip', async (key) => {
		selectMock.mockResolvedValueOnce('typesafe' as never);
		passwordMock.mockResolvedValueOnce(key as never);

		const result = await pickDecisionProvider();

		expect(result).toEqual({ env: {}, isPlaneConfigured: false });
	});

	it('cancels the wizard when the provider question is cancelled', async () => {
		selectMock.mockResolvedValueOnce(Symbol('cancel') as never);
		isCancelMock.mockReturnValueOnce(true);

		expect(await pickDecisionProvider()).toBeNull();
		expect(passwordMock).not.toHaveBeenCalled();
	});

	it('cancels the wizard when the key prompt is cancelled', async () => {
		selectMock.mockResolvedValueOnce('typesafe' as never);
		passwordMock.mockResolvedValueOnce(Symbol('cancel') as never);
		isCancelMock.mockReturnValueOnce(false).mockReturnValueOnce(true);

		expect(await pickDecisionProvider()).toBeNull();
	});
});
