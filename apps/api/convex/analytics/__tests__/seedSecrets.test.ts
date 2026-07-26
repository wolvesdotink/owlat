import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	isSeedProbeId,
	SEED_PROBE_HEADER,
	toSeedAccountLogView,
} from '@owlat/shared/seedPlacement';
import { buildSeedShadowEnvelope } from '../../delivery/seedShadowCopy';
import type { CampaignEnvelopeInput } from '../../delivery/seedShadowCopy';
import { buildComposeInput } from '../../delivery/worker';
import { composeForSend } from '../../delivery/sendComposition';
import type { Id } from '../../_generated/dataModel';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const seedPlacementSource = readFileSync(here('../seedPlacement.ts'), 'utf8');
const shadowCopySource = readFileSync(here('../../delivery/seedShadowCopy.ts'), 'utf8');
const schemaSource = readFileSync(here('../../schema/seedPlacement.ts'), 'utf8');

const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
beforeAll(() => {
	process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';
});
afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
});

/** (e) Credentials are sealed and never logged. */
describe('seed credentials', () => {
	it('reuses the shipped sealed envelope — no seed module reads a credential field', () => {
		for (const source of [seedPlacementSource, shadowCopySource, schemaSource]) {
			expect(source).not.toContain('secretCiphertext');
			expect(source).not.toContain('secretIv');
			expect(source).not.toContain('secretAuthTag');
			expect(source).not.toContain('imapPassword');
			expect(source).not.toContain('smtpPassword');
		}
	});

	it('defines no second credential model — seeds are ordinary external accounts', () => {
		expect(schemaSource).toContain("v.id('externalMailAccounts')");
		expect(schemaSource).not.toContain('password');
	});

	it('logs a seed account only as provider + domain, never the address or a secret', () => {
		const view = toSeedAccountLogView({
			accountId: 'acct_1',
			provider: 'gmail',
			address: 'Owlat.Seed.01@Gmail.Example',
		});
		expect(view).toEqual({ accountId: 'acct_1', provider: 'gmail', domain: 'gmail.example' });
		expect(JSON.stringify(view)).not.toContain('owlat.seed.01');
	});

	it('degrades safely on a malformed address', () => {
		expect(
			toSeedAccountLogView({ accountId: 'a', provider: 'other', address: 'not-an-address' }).domain
		).toBe('');
	});
});

/** (e) Mailbox CONTENTS are never logged — or even stored. */
describe('seed mailbox contents', () => {
	it('never enters Convex: the ledger stores a folder NAME and timestamps only', () => {
		for (const field of ['subject', 'bodyHtml', 'bodyText', 'snippet', 'rawMessage']) {
			expect(schemaSource).not.toContain(`${field}:`);
		}
		expect(schemaSource).toContain('folderName');
	});

	it('is never console-logged by either seed module', () => {
		for (const source of [seedPlacementSource, shadowCopySource]) {
			expect(source).not.toMatch(/console\.(log|info|warn|error|debug)\(/);
		}
	});
});

/** (e) The probe header carries no PII and never reaches a real recipient. */
describe('the probe header', () => {
	const realSend: CampaignEnvelopeInput = {
		kind: 'campaign',
		to: 'jane@example.com',
		from: 'news@org.example',
		template: { subject: 'Hello', htmlContent: '<p>Hello</p>' },
		contactInfo: {
			contactId: 'contact1' as Id<'contacts'>,
			email: 'jane@example.com',
			firstName: 'Jane',
		},
		emailSendId: 'send1' as Id<'emailSends'>,
		campaignId: 'campaign1' as Id<'campaigns'>,
		organizationId: 'org_1',
		convexSiteUrl: 'https://convex.example',
		siteUrl: 'https://app.example',
	};
	const probeId = 'sp_abcdefghij0123456789kl';
	const shadow = buildSeedShadowEnvelope(realSend, {
		address: 'owlat.seed.01@gmail.example',
		probeId,
	});
	const headerValue = composeForSend(buildComposeInput(shadow)).headers[SEED_PROBE_HEADER];

	it('is an opaque id', () => {
		expect(headerValue).toBe(probeId);
		expect(isSeedProbeId(headerValue ?? '')).toBe(true);
	});

	it('leaks no recipient PII', () => {
		expect(headerValue).not.toContain('jane');
		expect(headerValue).not.toContain('example.com');
		expect(headerValue).not.toContain('contact1');
		expect(headerValue).not.toContain('owlat.seed.01');
	});

	it('leaks no campaign PII', () => {
		expect(headerValue).not.toContain('campaign1');
		expect(headerValue).not.toContain('Hello');
		expect(headerValue).not.toContain('org_1');
	});

	it('never reaches a real recipient — a countable Send cannot carry it', () => {
		const realHeaders = composeForSend(buildComposeInput(realSend)).headers;
		expect(realHeaders[SEED_PROBE_HEADER]).toBeUndefined();
		// And the reverse invariant: an envelope carrying the probe header has no
		// emailSendId, so it can never be dispatched as a countable Send.
		expect(shadow.emailSendId).toBeUndefined();
	});
});
