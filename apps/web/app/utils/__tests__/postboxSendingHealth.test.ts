/**
 * The personal sending-health verdict (plan idea 12).
 *
 * The card exists to tell a member something true about their own mail, so the
 * failure modes worth pinning are the dishonest ones:
 *  - claiming "your mail is arriving" off an alignment we never confirmed;
 *  - greeting a member who has simply never sent anything with a warning;
 *  - naming a vague "you have bounces" as the next step when the newest failure
 *    already carries a concrete instruction.
 */
import { describe, it, expect } from 'vitest';

import {
	deriveSendingHealth,
	type SendingHealthIdentity,
	type SendingHealthStats,
} from '../postboxSendingHealth';
import { createTestI18n } from '~/__tests__/i18n';

const { t, te } = createTestI18n().global;

function render(value: string | { key: string; params?: Record<string, unknown> }): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const verified: SendingHealthIdentity = {
	address: 'me@hinterland.camp',
	domainVerified: true,
	alignment: 'aligned',
};

function stats(over: Partial<SendingHealthStats> = {}): SendingHealthStats {
	return {
		sends: 0,
		attempts: 0,
		accepted: 0,
		bounced: 0,
		failed: 0,
		pending: 0,
		latestFailure: null,
		...over,
	};
}

describe('deriveSendingHealth — the verdict', () => {
	it('is ready for a verified, aligned member whose recent mail all landed', () => {
		const health = deriveSendingHealth({
			identity: verified,
			stats: stats({ sends: 12, attempts: 14, accepted: 14 }),
		});
		expect(health.level).toBe('ready');
		expect(health.tone).toBe('success');
		expect(render(health.nextStep)).toContain('Nothing to fix');
	});

	it('stays ready for a member who has simply never sent anything', () => {
		// Untested is not unhealthy. Opening preferences on a brand-new mailbox
		// must not greet someone with a warning about mail they never sent.
		const health = deriveSendingHealth({ identity: verified, stats: stats() });
		expect(health.level).toBe('ready');
		expect(render(health.gates[2]!.detail)).toContain("haven't sent anything");
		expect(health.gates[2]!.status).toBe('pending');
	});

	it('never claims all-clear off an alignment it could not confirm', () => {
		const health = deriveSendingHealth({
			identity: { ...verified, alignment: 'unknown' },
			stats: stats({ sends: 5, attempts: 5, accepted: 5 }),
		});
		expect(health.level).toBe('incomplete');
		// A caution, not an accusation: nothing was verified to fail.
		expect(health.gates[1]!.status).toBe('pending');
	});

	it('blocks on an unverified domain, because sending really is off', () => {
		const health = deriveSendingHealth({
			identity: { ...verified, domainVerified: false, alignment: 'unknown' },
			stats: stats(),
		});
		expect(health.level).toBe('blocked');
		expect(health.tone).toBe('error');
		expect(render(health.nextStep)).toContain('sending from it is turned off');
		// Alignment has nothing to say until the domain settles — one breakage,
		// not two.
		expect(health.gates[1]!.status).toBe('pending');
	});

	it('leads with the misalignment when mail sends but goes to spam', () => {
		const health = deriveSendingHealth({
			identity: { ...verified, alignment: 'misaligned' },
			stats: stats({ sends: 3, attempts: 3, accepted: 3 }),
		});
		expect(health.level).toBe('incomplete');
		expect(health.gates[1]!.status).toBe('attention');
		expect(render(health.nextStep)).toContain('can treat it as spam');
	});
});

describe('deriveSendingHealth — the bounce half', () => {
	it('names the newest failure’s own next action rather than "you have bounces"', () => {
		const health = deriveSendingHealth({
			identity: verified,
			stats: stats({
				sends: 20,
				attempts: 20,
				accepted: 19,
				bounced: 1,
				latestFailure: {
					address: 'jonas@acme.example',
					state: 'bounced',
					at: 1_770_000_000_000,
					bounceMessage: '550 5.1.1 no mailbox by that name',
				},
			}),
		});
		expect(health.level).toBe('incomplete');
		expect(render(health.nextStep)).toContain('Check the spelling');
	});

	it('goes amber for a stray failure and red for a real failure rate', () => {
		const stray = deriveSendingHealth({
			identity: verified,
			stats: stats({ sends: 20, attempts: 20, accepted: 19, bounced: 1 }),
		});
		const bad = deriveSendingHealth({
			identity: verified,
			stats: stats({ sends: 20, attempts: 20, accepted: 12, bounced: 8 }),
		});
		expect(stray.gates[2]!.tone).toBe('warning');
		expect(bad.gates[2]!.tone).toBe('error');
	});

	it('withholds a share until enough was sent for a share to mean anything', () => {
		// One bounce out of three is not "33% of your mail bounces"; it is one
		// bad address. The counts still show, the percentage does not.
		const thin = deriveSendingHealth({
			identity: verified,
			stats: stats({ sends: 3, attempts: 3, accepted: 2, bounced: 1 }),
		});
		expect(thin.ratio).toBeNull();
		expect(thin.gates[2]!.tone).toBe('warning');

		const enough = deriveSendingHealth({
			identity: verified,
			stats: stats({ sends: 12, attempts: 12, accepted: 11, failed: 1 }),
		});
		expect(enough.ratio).toEqual({ failures: 1, attempts: 12 });
	});
});

describe('every line the card can render resolves', () => {
	const cases: Array<[string, ReturnType<typeof deriveSendingHealth>]> = [
		['loading', deriveSendingHealth({ identity: null, stats: null })],
		['clean', deriveSendingHealth({ identity: verified, stats: stats({ sends: 4, attempts: 4 }) })],
		[
			'unverified',
			deriveSendingHealth({
				identity: { ...verified, domainVerified: false },
				stats: stats(),
			}),
		],
		[
			'failing',
			deriveSendingHealth({
				identity: { ...verified, alignment: 'misaligned' },
				stats: stats({ sends: 9, attempts: 11, accepted: 8, bounced: 3 }),
			}),
		],
	];

	it.each(cases)('%s renders no bare key', (_name, health) => {
		const lines = [
			health.headline,
			health.nextStep,
			...health.gates.flatMap((g) => [g.title, g.detail]),
		];
		for (const line of lines) {
			const key = typeof line === 'string' ? line : line.key;
			// A worded reason handed over by the alignment check is not a key and
			// passes through as itself; everything the catalog owns must exist.
			if (key.startsWith('shared.')) expect(te(key)).toBe(true);
			expect(render(line)).not.toBe('');
		}
	});
});
