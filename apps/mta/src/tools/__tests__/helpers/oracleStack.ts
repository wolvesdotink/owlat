/**
 * Shared OLD (oracle) inbound stack for the shadow-replay suites.
 *
 * The differential harness compares the in-house `owlatNewStack` against the
 * library the cutover replaces: mailparser (`simpleParser`) for the routing
 * drivers, and the ACTUAL production DKIM driver (`bounce/inboundDkim.verifyDkim`
 * — the exact code the inbound path runs today, never a re-implemented copy) for
 * the auth verdict. Both replay suites (`replay.corpus.test.ts` and
 * `replay.imap.test.ts`) drive the same oracle side, so it lives here once. The
 * oracle library import stays in test code (I1); this helper is test-only and is
 * never imported by the shipped tool.
 */

import { simpleParser } from 'mailparser';
import { verifyDkim as verifyDkimOld } from '../../../bounce/inboundDkim';
import {
	projectDrivers,
	resolverFromHint,
	type AuthVerdicts,
	type ReplayInput,
	type ReplayStackSide,
	type RoutingDrivers,
} from '../../inboundReplay';

/**
 * The OLD (oracle) stack: mailparser for the routing drivers, and the production
 * DKIM driver for the verdict. Both verifiers return a verdict unconditionally
 * (`none` for an unsigned message), so unsigned corpus mail yields matching
 * `none` verdicts and no auth diff.
 */
export const oracleOldStack: ReplayStackSide = {
	async project(raw: Buffer): Promise<RoutingDrivers> {
		const parsed = await simpleParser(raw);
		return projectDrivers(parsed, (name) => parsed.headers.get(name));
	},
	async auth(input: ReplayInput): Promise<AuthVerdicts> {
		const inner = resolverFromHint(input.dkim);
		const outcome = await verifyDkimOld(input.raw, { resolver: (name) => inner(name, 'TXT') });
		return { dkim: outcome.result };
	},
};
