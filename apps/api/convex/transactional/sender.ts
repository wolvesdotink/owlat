/**
 * The transactional sender: the address template API sends go out from, set
 * for the instance and, optionally, per template. Resolution (template, then
 * transactional, then default sender) lives in `dispatchDecision.ts`; the
 * reads and the save-time floor in `senderResolution.ts`.
 *
 * Both settings are optional. Unset means "use the next layer down", so an
 * install that never touches them keeps sending from its default sender.
 */

import { v } from 'convex/values';
import { transactionalMutation, transactionalQuery } from './_helpers';
import { getOrThrow } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { getInstanceSettings, upsertInstanceSettings } from '../lib/instanceSettings';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import { resolveTransactionalSender } from './dispatchDecision';
import {
	loadTransactionalSender,
	requireVerifiedSender,
	suggestTransactionalDomain,
	transactionalSenderInputs,
} from './senderResolution';

const senderValidator = v.union(
	v.null(),
	v.object({ email: v.string(), name: v.optional(v.string()) })
);

type StoredSender = { email: string; name: string | null } | null;

const stored = (email: string | undefined, name: string | undefined): StoredSender =>
	email?.trim() ? { email: email.trim(), name: name?.trim() || null } : null;

/**
 * Everything the sender surfaces show: the address a send resolves to with its
 * verdict, each configured layer so the editor can say what it falls back to,
 * the sending domains to choose from, and the transactional subdomain to
 * suggest. With `templateId`, the resolution is that template's.
 */
// all-members: which address transactional mail goes out from is shown next to
// the readiness verdict to everyone who can open the Transactional page; it
// holds no secret. Changing either setting is gated in the mutations below.
export const get = transactionalQuery({
	args: { templateId: v.optional(v.id('transactionalEmails')) },
	handler: async (ctx, args, session) => {
		const settings = await getInstanceSettings(ctx.db);
		const template = args.templateId ? await ctx.db.get(args.templateId) : null;
		const resolved = await loadTransactionalSender(ctx, { settings, template });
		// What a template that names no sender would use: the editor's
		// "Uses the transactional sender (...)" line.
		const inherited = resolveTransactionalSender(transactionalSenderInputs(settings, null));
		const domains = await ctx.db.query('domains').collect(); // bounded: per-deployment sending domains are few
		const sendingDomains = domains
			.map((domain) => ({ domain: domain.domain, isVerified: domain.status === 'verified' }))
			.sort((a, b) =>
				a.isVerified === b.isVerified ? a.domain.localeCompare(b.domain) : a.isVerified ? -1 : 1
			);
		const defaultSender = resolveTransactionalSender({
			...transactionalSenderInputs(settings, null),
			settings: settings
				? { defaultFromEmail: settings.defaultFromEmail, defaultFromName: settings.defaultFromName }
				: null,
		});
		return {
			resolved,
			inherited: inherited
				? { address: inherited.fromEmail, name: inherited.fromName, source: inherited.source }
				: null,
			transactional: stored(settings?.transactionalFromEmail, settings?.transactionalFromName),
			template: template ? stored(template.fromEmail, template.fromName) : null,
			defaultSender: defaultSender
				? { address: defaultSender.fromEmail, name: defaultSender.fromName }
				: null,
			sendingDomains,
			suggestedDomain: suggestTransactionalDomain(
				sendingDomains.filter((d) => d.isVerified).map((d) => d.domain),
				defaultSender?.fromEmail ?? null
			),
			canManageInstance: hasPermission(session.role, 'settings:manage'),
			canManageTemplate: hasPermission(session.role, 'templates:manage'),
		};
	},
});

/**
 * Set or clear the instance's transactional sender. `null` clears it, and
 * template sends that name no sender go back to the default sender.
 */
export const setInstanceSender = transactionalMutation({
	args: { sender: senderValidator },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'settings:manage'),
			'Only owners and admins can change the transactional sender'
		);
		const next = args.sender ? await requireVerifiedSender(ctx, args.sender) : null;
		const existing = await getInstanceSettings(ctx.db);
		const from = stored(existing?.transactionalFromEmail, existing?.transactionalFromName);
		const settingsId = await upsertInstanceSettings(ctx, {
			// `undefined` removes the field from the row.
			transactionalFromEmail: next?.email,
			transactionalFromName: next?.name,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'settings.transactional_sender_updated',
			resource: 'settings',
			resourceId: settingsId,
			detailsBlob: JSON.stringify({
				from,
				to: next ? { email: next.email, name: next.name ?? null } : null,
			}),
		});
		return null;
	},
});

/**
 * Give one template its own sender, or `null` to go back to the transactional
 * sender. A sender is a send setting, not content: it saves on a published
 * template without unpublishing it.
 */
export const setTemplateSender = transactionalMutation({
	args: { id: v.id('transactionalEmails'), sender: senderValidator },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'templates:manage'),
			'Only owners and admins can change a transactional email’s sender'
		);
		const email = await getOrThrow(ctx, args.id, 'Transactional email');
		const next = args.sender ? await requireVerifiedSender(ctx, args.sender) : null;
		await ctx.db.patch(args.id, {
			fromEmail: next?.email,
			fromName: next?.name,
			updatedAt: Date.now(),
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'transactional_email.sender_updated',
			resource: 'transactional_email',
			resourceId: args.id,
			details: {
				from: email.fromEmail ?? 'transactional sender',
				to: next?.email ?? 'transactional sender',
			},
		});
		return null;
	},
});
