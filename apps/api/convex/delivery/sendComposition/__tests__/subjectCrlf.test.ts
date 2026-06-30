import { describe, it, expect, afterEach, vi } from 'vitest';
import { composeCampaign } from '../campaign';
import { composeForSend } from '../index';
import { buildComposeInput } from '../../worker';
import { sendProviderDispatch } from '../../../lib/sendProviders/dispatch';
import { mtaSendProvider } from '../../../lib/sendProviders/mta';
import type { EmailSendParams } from '../../../lib/sendProviders/types';
import type { Id } from '../../../_generated/dataModel';

/**
 * Regression-lock for audit item PR-43 (Header-injection, RFC 5322 §2.2).
 *
 * A personalized subject (`personalize(..., { escape: 'header' })`) must strip
 * CR/LF so a hostile contact field cannot inject a second mail header (`Bcc:`,
 * `To:`, …). This is PRODUCER-SIDE defense-in-depth: before PR-43 every CRLF
 * guard lived in the transport, and the SES attachment path had none (PR-41),
 * so a `firstName` of `"Bob\r\nBcc: x@evil.com"` could reach the wire as two
 * header lines.
 *
 * Two layers are asserted:
 *  1. `composeCampaign(...).subject` carries no `\r`/`\n` (fails before the fix).
 *  2. End-to-end via the exact worker dispatch chain
 *     (`buildComposeInput` → `composeForSend` → `sendProviderDispatch`): the
 *     subject params handed to the provider carry no bare CR/LF, so none can
 *     reach `sendProviderDispatch` regardless of the chosen transport.
 */

const HOSTILE_FIRST_NAME = 'Bob\r\nBcc: x@evil.com';
const CRLF_RE = /[\r\n]/;
const BCC_LINE_RE = /^Bcc:/im;

describe('personalized subject — CRLF neutralization (PR-43)', () => {
	it('composeCampaign strips CR/LF from a personalized subject', () => {
		const out = composeCampaign({
			kind: 'campaign',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>x</p>' },
			contactInfo: { email: 'a@b.com', firstName: HOSTILE_FIRST_NAME },
		});

		// The injected CRLF + Bcc header must be neutralized in the subject.
		expect(out.subject).not.toMatch(CRLF_RE);
		expect(out.subject).not.toMatch(BCC_LINE_RE);
		// The value still substitutes — only the CRLF is collapsed to a space.
		expect(out.subject).toContain('Bob');
		expect(out.subject).toBe('Hi Bob Bcc: x@evil.com');
	});

	it('strips CR/LF from a transactional personalized subject too', () => {
		const out = composeForSend({
			kind: 'transactional',
			template: { subject: 'Receipt for {{name}}', htmlContent: '<p>x</p>' },
			dataVariables: { name: 'Bob\r\nBcc: x@evil.com' },
		});

		expect(out.subject).not.toMatch(CRLF_RE);
		expect(out.subject).not.toMatch(BCC_LINE_RE);
	});

	it('strips a bare CR and a bare LF (not just the CRLF pair)', () => {
		const cr = composeCampaign({
			kind: 'campaign',
			template: { subject: '{{firstName}}', htmlContent: '<p>x</p>' },
			contactInfo: { email: 'a@b.com', firstName: 'A\rBcc: x@evil.com' },
		});
		const lf = composeCampaign({
			kind: 'campaign',
			template: { subject: '{{firstName}}', htmlContent: '<p>x</p>' },
			contactInfo: { email: 'a@b.com', firstName: 'A\nBcc: x@evil.com' },
		});

		expect(cr.subject).not.toMatch(CRLF_RE);
		expect(lf.subject).not.toMatch(CRLF_RE);
	});
});

describe('worker dispatch path — no bare CR/LF reaches sendProviderDispatch (PR-43)', () => {
	afterEach(() => vi.restoreAllMocks());

	it('the subject handed to the provider has no bare CR/LF (end-to-end)', async () => {
		// Capture the params the worker dispatch path would hand the transport.
		let dispatchedParams: EmailSendParams | undefined;
		vi.spyOn(mtaSendProvider, 'sendEmail').mockImplementation(async (params) => {
			dispatchedParams = params;
			return { success: true, id: 'msg-1' };
		});

		// Reproduce the exact worker chain: buildComposeInput → composeForSend →
		// sendProviderDispatch (worker.ts sendSingleEmail).
		const composeInput = buildComposeInput({
			kind: 'campaign',
			to: 'jane@example.com',
			from: 'news@org.example',
			template: { subject: 'Hi {{firstName}}', htmlContent: '<p>Hi {{firstName}}</p>' },
			contactInfo: {
				contactId: 'contact1' as Id<'contacts'>,
				email: 'jane@example.com',
				firstName: HOSTILE_FIRST_NAME,
			},
		});
		const composed = composeForSend(composeInput);

		const fakeCtx = {
			scheduler: { runAfter: async () => undefined },
		};
		await sendProviderDispatch(
			fakeCtx as never,
			'mta',
			{
				to: 'jane@example.com',
				from: 'news@org.example',
				subject: composed.subject,
				html: composed.html,
			},
		);

		expect(dispatchedParams).toBeDefined();
		expect(dispatchedParams!.subject).not.toMatch(CRLF_RE);
		expect(dispatchedParams!.subject).not.toMatch(BCC_LINE_RE);
		expect(dispatchedParams!.subject).toContain('Bob');
	});
});
