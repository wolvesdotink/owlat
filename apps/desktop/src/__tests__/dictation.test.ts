import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Rust commands' argument names are the contract: `lang`, `onEvent` (a
// Channel) and `session`.
const { invokeMock, channels } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	channels: [] as { deliver: (event: unknown) => void }[],
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
	Channel: class {
		deliver: (event: unknown) => void;
		constructor(onmessage: (event: unknown) => void) {
			this.deliver = onmessage;
			channels.push(this);
		}
	},
}));

import { dictationAvailable, dictationCancel, dictationStart, dictationStop } from '../dictation';

describe('dictation bridge', () => {
	beforeEach(() => {
		invokeMock.mockReset();
		channels.length = 0;
	});

	it('asks the shell whether a language can be dictated on-device', async () => {
		invokeMock.mockResolvedValue(true);
		await expect(dictationAvailable('de-DE')).resolves.toBe(true);
		expect(invokeMock).toHaveBeenCalledWith('dictation_available', { lang: 'de-DE' });
	});

	it('starts a session whose events reach the caller, and stops or cancels it by id', async () => {
		invokeMock.mockResolvedValue(3);
		const onEvent = vi.fn();
		await expect(dictationStart('en-US', onEvent)).resolves.toBe(3);
		const channel = channels[0]!;
		expect(invokeMock).toHaveBeenCalledWith('dictation_start', { lang: 'en-US', onEvent: channel });
		channel.deliver({ kind: 'phrase', text: 'Thursday works.' });
		expect(onEvent).toHaveBeenCalledWith({ kind: 'phrase', text: 'Thursday works.' });

		invokeMock.mockResolvedValue(undefined);
		await dictationStop(3);
		expect(invokeMock).toHaveBeenCalledWith('dictation_stop', { session: 3 });
		await dictationCancel(3);
		expect(invokeMock).toHaveBeenCalledWith('dictation_cancel', { session: 3 });
	});
});
