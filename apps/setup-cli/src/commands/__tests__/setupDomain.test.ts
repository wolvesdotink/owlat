import { describe, it, expect, vi, beforeEach } from 'vitest';
import { systemFromIdentityEnv } from '@owlat/shared/systemFromIdentity';

/**
 * The terminal wizard's sending-identity step, driven through mocked clack
 * prompts. The step is the only place the interactive install (`curl … | bash`
 * → `quickstart --terminal`) learns a domain, so it has to leave with the
 * system From identity as well as the EHLO and bounce names. Without it the
 * Convex runtime sends verification and invitation mail from a placeholder
 * domain.
 */

interface PromptCall {
	message: string;
	placeholder?: string;
	initialValue?: string;
	validate?: (value: string | undefined) => string | Error | undefined;
}

const CANCEL = Symbol('cancel');

const driver = vi.hoisted(() => ({
	calls: [] as PromptCall[],
	answers: {} as Record<string, unknown>,
}));

vi.mock('@clack/prompts', () => {
	const text = async (options: PromptCall): Promise<unknown> => {
		driver.calls.push(options);
		if (!(options.message in driver.answers)) {
			throw new Error(`unexpected prompt: ${options.message}`);
		}
		const answer = driver.answers[options.message];
		// Pressing Enter on a prompt with an initial value accepts that value.
		return answer === undefined ? options.initialValue : answer;
	};
	return {
		text,
		group: async (prompts: Record<string, () => Promise<unknown>>) => {
			const result: Record<string, unknown> = {};
			for (const [key, run] of Object.entries(prompts)) result[key] = await run();
			return result;
		},
		isCancel: (value: unknown) => value === CANCEL,
	};
});

// No sending IP detected, so the PTR announcement (which does DNS) is skipped.
vi.mock('../../lib/outboundIp', () => ({ detectPrimaryIpv4: () => null }));

import { collectDomain } from '../setupDomain';
import { buildEnvPatchFromConfig, type SetupConfig } from '../../lib/setupConfig';

const EHLO = "EHLO hostname (must match this server's reverse DNS / PTR record)";
const BOUNCE = 'Bounce / Return-Path domain';
const FROM = 'From address for system mail (sign-up verification, password resets, invitations)';

function answer(from: unknown) {
	driver.answers = { [EHLO]: 'mail.example.com', [BOUNCE]: 'bounces.example.com', [FROM]: from };
}

beforeEach(() => {
	driver.calls = [];
	driver.answers = {};
});

describe('collectDomain — system From identity', () => {
	it('proposes noreply@<EHLO hostname> and writes DEFAULT_FROM_* when the operator accepts it', async () => {
		answer(undefined);
		const env = await collectDomain();
		expect(driver.calls.find((c) => c.message === FROM)?.initialValue).toBe(
			'noreply@mail.example.com'
		);
		expect(env).toEqual({
			EHLO_HOSTNAME: 'mail.example.com',
			RETURN_PATH_DOMAIN: 'bounces.example.com',
			DEFAULT_FROM_DOMAIN: 'mail.example.com',
			DEFAULT_FROM_EMAIL: 'noreply@mail.example.com',
			DEFAULT_FROM_NAME: 'Owlat',
		});
	});

	it('takes the From domain from an address the operator typed instead', async () => {
		answer('hello@example.com');
		const env = await collectDomain();
		expect(env).toMatchObject({
			DEFAULT_FROM_DOMAIN: 'example.com',
			DEFAULT_FROM_EMAIL: 'hello@example.com',
			DEFAULT_FROM_NAME: 'Owlat',
		});
	});

	it('proposes the address an earlier run configured, not a fresh one', async () => {
		answer(undefined);
		const env = await collectDomain({ DEFAULT_FROM_EMAIL: 'team@example.com' });
		expect(driver.calls.find((c) => c.message === FROM)?.initialValue).toBe('team@example.com');
		expect(env?.['DEFAULT_FROM_DOMAIN']).toBe('example.com');
	});

	it('refuses an entry that is not an email address at the prompt', async () => {
		answer(undefined);
		await collectDomain();
		const validate = driver.calls.find((c) => c.message === FROM)?.validate;
		expect(validate?.('not-an-address')).toBeTruthy();
		expect(validate?.('noreply@mail.example.com')).toBeUndefined();
	});

	it('returns null when the From prompt is cancelled', async () => {
		answer(CANCEL);
		await expect(collectDomain()).resolves.toBeNull();
	});

	it('writes the same DEFAULT_FROM_* as the config-file path and the shared helper', async () => {
		answer(undefined);
		const interactive = await collectDomain();
		const fromConfig = buildEnvPatchFromConfig({
			version: 1,
			deploymentMode: 'selfhost',
			features: {},
			admin: { email: 'admin@example.com', name: 'Admin', password: 'a-long-password' },
			domain: { ehloHostname: 'mail.example.com', bounceDomain: 'bounces.example.com' },
		} as SetupConfig);
		const pick = (env: Record<string, string> | null) => ({
			DEFAULT_FROM_DOMAIN: env?.['DEFAULT_FROM_DOMAIN'],
			DEFAULT_FROM_EMAIL: env?.['DEFAULT_FROM_EMAIL'],
			DEFAULT_FROM_NAME: env?.['DEFAULT_FROM_NAME'],
		});
		expect(pick(interactive)).toEqual(systemFromIdentityEnv('mail.example.com'));
		expect(pick(fromConfig)).toEqual(systemFromIdentityEnv('mail.example.com'));
	});
});
