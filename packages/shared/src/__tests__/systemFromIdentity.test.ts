import { describe, it, expect } from 'vitest';
import { proposedSystemFromEmail, systemFromIdentityEnv } from '../systemFromIdentity';

describe('systemFromIdentityEnv', () => {
	it('proposes noreply@ on the sending hostname', () => {
		expect(proposedSystemFromEmail(' mail.example.com ')).toBe('noreply@mail.example.com');
		expect(systemFromIdentityEnv('mail.example.com')).toEqual({
			DEFAULT_FROM_DOMAIN: 'mail.example.com',
			DEFAULT_FROM_EMAIL: 'noreply@mail.example.com',
			DEFAULT_FROM_NAME: 'Owlat',
		});
	});

	it('takes the domain from an address the operator chose', () => {
		expect(systemFromIdentityEnv('mail.example.com', 'hello@example.com', 'Acme')).toEqual({
			DEFAULT_FROM_DOMAIN: 'example.com',
			DEFAULT_FROM_EMAIL: 'hello@example.com',
			DEFAULT_FROM_NAME: 'Acme',
		});
	});

	it('treats a blank address or name as not chosen', () => {
		expect(systemFromIdentityEnv('mail.example.com', '  ', '')).toEqual(
			systemFromIdentityEnv('mail.example.com')
		);
	});
});
