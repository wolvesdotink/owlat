/**
 * The transactional sender as the database and the deployment hold it: the
 * inputs {@link resolveTransactionalSender} reads (settings row, template,
 * environment), the resolved address with its domain verdict, and the
 * save-time floor that keeps an unverified address out of either setting.
 *
 * The intake (`dispatch.ts`), the readiness query (`delivery/status.ts`), the
 * delivery health roll-up (`delivery/health.ts`) and the sender query the
 * editor's test send reads (`sender.ts`) all come through here.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';
import { checkEmailDomainVerification } from '../domains/domains';
import { isTransactionalStreamHost, transactionalStreamHost } from '../domains/streamSubdomains';
import { getOptional } from '../lib/env';
import { isValidEmail } from '../lib/inputGuards';
import {
	resolveTransactionalSender,
	type TransactionalSenderInputs,
	type TransactionalSenderSource,
} from './dispatchDecision';

/** The resolution inputs for a settings row and, optionally, one template. */
export function transactionalSenderInputs(
	settings: TransactionalSenderInputs['settings'],
	template?: TransactionalSenderInputs['template']
): TransactionalSenderInputs {
	return {
		settings,
		template: template ?? null,
		environment: {
			defaultFromEmail: getOptional('DEFAULT_FROM_EMAIL'),
			defaultFromName: getOptional('DEFAULT_FROM_NAME'),
		},
	};
}

export interface TransactionalSenderState {
	/** `null` when no sender is configured at any layer. */
	readonly address: string | null;
	readonly name: string | null;
	readonly source: TransactionalSenderSource | null;
	readonly isDomainVerified: boolean;
}

/**
 * The sender a send of `template` (or, without one, any template that names no
 * sender) resolves to, and whether its domain is verified. Reads the settings
 * row unless the caller already holds it.
 */
export async function loadTransactionalSender(
	ctx: QueryCtx | MutationCtx,
	options: {
		readonly settings?: Doc<'instanceSettings'> | null;
		readonly template?: TransactionalSenderInputs['template'];
	} = {}
): Promise<TransactionalSenderState> {
	const settings =
		options.settings !== undefined
			? options.settings
			: await ctx.db.query('instanceSettings').first();
	const sender = resolveTransactionalSender(
		transactionalSenderInputs(settings ?? null, options.template)
	);
	if (!sender) return { address: null, name: null, source: null, isDomainVerified: false };
	const status = await checkEmailDomainVerification(ctx, sender.fromEmail);
	return {
		address: sender.fromEmail,
		name: sender.fromName,
		source: sender.source,
		isDomainVerified: status.verified,
	};
}

/** Longest display name a sender may carry; it becomes a header phrase. */
const MAX_SENDER_NAME_LENGTH = 100;

/**
 * Normalise a sender an operator is saving and refuse it unless its address is
 * well formed and on a verified sending domain. The message names the domain,
 * because the fix is to add or verify exactly that domain.
 */
export async function requireVerifiedSender(
	ctx: MutationCtx,
	sender: { readonly email: string; readonly name?: string }
): Promise<{ email: string; name: string | undefined }> {
	const email = sender.email.trim();
	if (!isValidEmail(email)) throwInvalidInput(`"${email}" is not a valid email address.`);
	const name = sender.name?.trim() || undefined;
	// A display name becomes part of the From header: a line break in it would
	// start a header of its own.
	if (name && (name.length > MAX_SENDER_NAME_LENGTH || /[\r\n]/.test(name))) {
		throwInvalidInput(
			`A sender name must be one line of at most ${MAX_SENDER_NAME_LENGTH} characters.`
		);
	}
	const status = await checkEmailDomainVerification(ctx, email);
	if (!status.verified) {
		throwInvalidInput(
			status.exists
				? `${status.domain} is not verified yet, so mail from ${email} would be refused. Verify it under Domains, then save again.`
				: `${status.domain} is not one of your sending domains, so mail from ${email} would be refused. Add and verify it under Domains, then save again.`
		);
	}
	return { email, name };
}

/**
 * The verified domain to offer as the transactional sender's domain: the
 * transactional stream's subdomain (`mail.<root>`) of the stream-subdomain
 * layout. The one beside the default sender's domain comes first, so
 * `hello@example.com` or `hello@news.example.com` both suggest
 * `mail.example.com`.
 */
export function suggestTransactionalDomain(
	verifiedDomains: readonly string[],
	defaultAddress: string | null
): string | null {
	const candidates = verifiedDomains.map((d) => d.toLowerCase()).filter(isTransactionalStreamHost);
	const defaultDomain = defaultAddress?.split('@')[1]?.trim().toLowerCase();
	if (defaultDomain) {
		const parent = defaultDomain.split('.').slice(1).join('.');
		const nearby = new Set(
			[defaultDomain, ...(parent.includes('.') ? [parent] : [])].map(transactionalStreamHost)
		);
		const match = candidates.find((host) => host === defaultDomain || nearby.has(host));
		if (match) return match;
	}
	return candidates[0] ?? null;
}
