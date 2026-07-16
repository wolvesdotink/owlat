/**
 * External-mailbox connect argument builders (utils/postboxConnectArgs):
 *   - trims text, coerces port strings, defaults the login to the address, and
 *   - layers the shared-inbox fields (deduped roster, blanked display name) for
 *     the team `connectShared` path (#234).
 */
import { describe, it, expect } from 'vitest';
import { buildCredentialArgs, buildSharedConnectArgs } from '../postboxConnectArgs';

const baseForm = {
	emailAddress: '  support@acme.test  ',
	imapHost: ' imap.acme.test ',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: ' smtp.acme.test ',
	smtpPort: 465,
	isSmtpSecure: true,
	username: '',
	password: 'app-pass',
};

describe('buildCredentialArgs', () => {
	it('trims fields and coerces ports to numbers', () => {
		const args = buildCredentialArgs({ ...baseForm, imapPort: 143 as unknown as number });
		expect(args.emailAddress).toBe('support@acme.test');
		expect(args.imapHost).toBe('imap.acme.test');
		expect(args.smtpHost).toBe('smtp.acme.test');
		expect(args.imapPort).toBe(143);
		expect(typeof args.imapPort).toBe('number');
	});

	it('defaults the login username to the email address when left blank', () => {
		expect(buildCredentialArgs(baseForm).username).toBe('support@acme.test');
	});

	it('keeps an explicit username (trimmed)', () => {
		expect(buildCredentialArgs({ ...baseForm, username: '  agent  ' }).username).toBe('agent');
	});

	it('passes the password through verbatim (never trimmed away)', () => {
		expect(buildCredentialArgs({ ...baseForm, password: '  spaced pw ' }).password).toBe(
			'  spaced pw '
		);
	});
});

describe('buildSharedConnectArgs', () => {
	it('carries the credential args plus a deduped roster', () => {
		const args = buildSharedConnectArgs(baseForm, {
			displayName: 'Support',
			memberUserIds: ['user-B', 'user-C', 'user-B'],
		});
		expect(args.emailAddress).toBe('support@acme.test');
		expect(args.displayName).toBe('Support');
		expect(args.memberUserIds).toEqual(['user-B', 'user-C']);
	});

	it('blanks an empty/whitespace display name to undefined', () => {
		expect(
			buildSharedConnectArgs(baseForm, { displayName: '   ', memberUserIds: [] }).displayName
		).toBeUndefined();
		expect(
			buildSharedConnectArgs(baseForm, { memberUserIds: [] }).displayName
		).toBeUndefined();
	});

	it('handles an empty roster', () => {
		expect(buildSharedConnectArgs(baseForm, { memberUserIds: [] }).memberUserIds).toEqual([]);
	});
});
