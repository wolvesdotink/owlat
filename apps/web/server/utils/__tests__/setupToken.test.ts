/**
 * `requireSetupToken`: the per-caller gate on the first-run setup endpoints.
 * `OWLAT_SETUP_MODE=true` only says no admin exists yet; without this check the
 * first caller to reach `/api/setup/apply` would own the instance.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSetupToken } from '@owlat/shared/setupToken';
import { requireSetupToken } from '../setupToken';
import { installNitroGlobals, requestEvent } from './nitro';

const TOKEN = generateSetupToken();
const ENV_KEY = 'OWLAT_SETUP_TOKEN';
const originalToken = process.env[ENV_KEY];

beforeEach(() => {
	installNitroGlobals();
	process.env[ENV_KEY] = TOKEN;
});

afterAll(() => {
	if (originalToken === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalToken;
});

describe('requireSetupToken', () => {
	it('lets the caller through when the header matches the configured token', () => {
		expect(requireSetupToken(requestEvent({ 'X-Setup-Token': TOKEN }))).toBeUndefined();
	});

	it('rejects a request without the header', () => {
		expect(() => requireSetupToken(requestEvent())).toThrow(
			expect.objectContaining({ statusCode: 401, message: expect.stringContaining('owlat setup') })
		);
	});

	it('rejects a wrong token', () => {
		expect(() => requireSetupToken(requestEvent({ 'x-setup-token': `${TOKEN}x` }))).toThrow(
			expect.objectContaining({ statusCode: 401 })
		);
	});

	it('fails closed when no token is configured, even if the caller sends one', () => {
		delete process.env[ENV_KEY];

		expect(() => requireSetupToken(requestEvent({ 'x-setup-token': TOKEN }))).toThrow(
			expect.objectContaining({ statusCode: 401 })
		);
	});

	it('fails closed on an empty configured token rather than accepting an empty header', () => {
		process.env[ENV_KEY] = '';

		expect(() => requireSetupToken(requestEvent({ 'x-setup-token': '' }))).toThrow(
			expect.objectContaining({ statusCode: 401 })
		);
	});
});
