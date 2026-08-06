/**
 * THE SYSTEM/AUTH MAIL PATH NAMES NO PROVIDER (the seams plan's P0.4).
 *
 * `systemMail.ts` carried the same fact three times: an `if (provider === 'mta')`
 * arm that built the MTA's system-intake payload inline, a
 * `provider === 'resend' && key` ternary for the dedup header, and — in
 * `lib/systemMailOutcome.ts` — a `provider === 'mta' || provider === 'resend'`
 * restatement deciding whether an ambiguous send could be repeated. Three copies
 * of one question: which transports deduplicate on the key we hand them?
 *
 * It is one catalog declaration now (`deduplicatesOnIdempotencyKey`) plus one
 * module method (`buildSystemMailExtras`), and the two are a PAIR — the
 * declaration is what tells a caller the repeat is safe, and the method is what
 * makes it true. The table below is the gate: it walks every core kind and
 * asserts the promise and the wiring agree, in BOTH directions, so a kind that
 * declares dedup and drops the key (a double delivery) and a kind that carries
 * the key without declaring it (an unnecessarily terminal password reset) each
 * fail here.
 *
 * The retry-disposition cases are driven by a MOCK KIND the old literal could
 * never have matched — proof the rule is read from the catalog rather than from
 * a list of two names.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSystemMailExtrasFor } from '../index';
import {
	SEND_PROVIDER_CATALOG,
	deduplicatesOnIdempotencyKeyFor,
	isCoreSendProviderKind,
	type SendProviderKind,
} from '../catalog';
import { systemMailRetryDisposition } from '../../systemMailOutcome';
import { EmailErrorCode } from '../types';

const KEY = 'stable-system-mail-key';

const coreKinds = SEND_PROVIDER_CATALOG.map((entry) => entry.kind).filter(isCoreSendProviderKind);

/** Does this payload carry the caller's key, under whatever name? */
function carriesKey(extras: unknown): boolean {
	return Object.values(extras as Record<string, unknown>).includes(KEY);
}

describe('buildSystemMailExtrasFor — the declaration and the wiring are one promise', () => {
	it('covers every core kind, so the table below cannot go vacuous', () => {
		expect(coreKinds).toEqual(['mta', 'ses', 'resend', 'smtp', 'mandrill']);
	});

	it.each(coreKinds)(
		'%s carries the idempotency key exactly when its catalog entry claims to dedup on it',
		(kind) => {
			// BOTH DIRECTIONS in one assertion. A kind declaring dedup and dropping
			// the key reports an ambiguous send as safe to retry and mails the
			// recipient twice; a kind carrying the key without declaring it leaves
			// every ambiguous password reset terminal for no reason.
			expect({
				kind,
				carriesKey: carriesKey(buildSystemMailExtrasFor(kind, { idempotencyKey: KEY })),
			}).toEqual({ kind, carriesKey: deduplicatesOnIdempotencyKeyFor(kind) });
		}
	);

	it('builds the MTA system-intake payload byte-for-byte as the inline arm did', () => {
		expect(buildSystemMailExtrasFor('mta', { idempotencyKey: KEY })).toEqual({
			ipPool: 'transactional',
			organizationId: 'system',
			intakePath: 'system',
			messageId: KEY,
		});
	});

	it('omits the MTA message id when the caller supplied no key, so the MTA mints one', () => {
		expect(buildSystemMailExtrasFor('mta', {})).toEqual({
			ipPool: 'transactional',
			organizationId: 'system',
			intakePath: 'system',
		});
	});

	it('gives Resend the dedup header only when there is a key to dedup on', () => {
		expect(buildSystemMailExtrasFor('resend', { idempotencyKey: KEY })).toEqual({
			idempotencyKey: KEY,
		});
		expect(buildSystemMailExtrasFor('resend', {})).toEqual({});
	});

	it.each(['ses', 'smtp', 'mandrill'] as const)(
		'gives %s the empty extras this path has always sent it',
		(kind) => {
			expect(buildSystemMailExtrasFor(kind, { idempotencyKey: KEY })).toEqual({});
		}
	);

	it('gives an unknown or plugin-tier kind the empty extras, fail closed', () => {
		// The plugin tier has no extras contract until P3.1, which is also why the
		// catalog refuses a bundled entry that claims to dedup — see
		// `pluginCustodyGuard.test.ts`.
		expect(
			buildSystemMailExtrasFor('plugin.mail-pack.hosted' as SendProviderKind, {
				idempotencyKey: KEY,
			})
		).toEqual({});
	});
});

describe('systemMailRetryDisposition reads the catalog, not a list of two names', () => {
	it.each(coreKinds)('classifies an ambiguous %s send from its declaration', (kind) => {
		expect({
			kind,
			disposition: systemMailRetryDisposition(kind, KEY, 'AMBIGUOUS_TIMEOUT'),
		}).toEqual({
			kind,
			disposition: deduplicatesOnIdempotencyKeyFor(kind) ? 'safe_to_retry' : 'terminal',
		});
	});

	it('is terminal without a key even for a transport that dedups', () => {
		// There is nothing to dedup ON. The MTA would mint a fresh message id for
		// the repeat, which is a second message.
		expect(systemMailRetryDisposition('mta', undefined, 'AMBIGUOUS_TIMEOUT')).toBe('terminal');
	});

	it('is terminal for a kind this deployment does not know', () => {
		expect(systemMailRetryDisposition('postmark', KEY, 'AMBIGUOUS_TIMEOUT')).toBe('terminal');
		expect(systemMailRetryDisposition(undefined, KEY, 'AMBIGUOUS_TIMEOUT')).toBe('terminal');
		expect(systemMailRetryDisposition('', KEY, 'AMBIGUOUS_TIMEOUT')).toBe('terminal');
	});

	it('leaves a known pre-accept failure retryable regardless of the transport', () => {
		expect(systemMailRetryDisposition('ses', KEY, EmailErrorCode.SERVER_ERROR)).toBe(
			'safe_to_retry'
		);
	});

	it('never treats a CONFIGURATION failure as retryable', () => {
		expect(systemMailRetryDisposition('mta', KEY, 'CONFIGURATION')).toBe('terminal');
	});
});

describe('a kind the old literal could never have matched', () => {
	afterEach(() => {
		vi.doUnmock('../catalog');
		vi.resetModules();
	});

	/**
	 * THE DIFFERENTIAL CASE for the disposition rule. `mock-dedupes` is neither
	 * `mta` nor `resend`, so `provider === 'mta' || provider === 'resend'` answered
	 * `terminal` for it no matter what it declared — this case is unsatisfiable by
	 * that literal, and unsatisfiable by any list over the shipped kinds.
	 *
	 * Driven through a mocked CATALOG rather than a mocked bundled manifest: the
	 * composition-time guard refuses a bundled plugin entry declaring `true`
	 * (`pluginCustodyGuard.test.ts`), precisely because the plugin tier cannot yet
	 * carry the key. What is under test here is the RULE, not the tier.
	 */
	it('credits a mock kind that declares dedup, and refuses one that does not', async () => {
		vi.resetModules();
		vi.doMock('../catalog', async (importOriginal) => {
			const actual = await importOriginal<typeof import('../catalog')>();
			return {
				...actual,
				isSendProviderKind: (kind: string | null | undefined) =>
					kind === 'mock-dedupes' || kind === 'mock-plain' || actual.isSendProviderKind(kind),
				deduplicatesOnIdempotencyKeyFor: (kind: string) =>
					kind === 'mock-dedupes'
						? true
						: kind === 'mock-plain'
							? false
							: actual.deduplicatesOnIdempotencyKeyFor(kind as SendProviderKind),
			};
		});
		const { systemMailRetryDisposition: rule } = await import('../../systemMailOutcome');

		expect(rule('mock-dedupes', KEY, 'AMBIGUOUS_TIMEOUT')).toBe('safe_to_retry');
		expect(rule('mock-plain', KEY, 'AMBIGUOUS_TIMEOUT')).toBe('terminal');

		vi.doUnmock('../catalog');
	});
});
