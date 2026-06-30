/**
 * Internal queries for personal mailboxes (used by Node actions
 * which can't run mutations directly).
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

export const getById = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => ctx.db.get(args.mailboxId),
});
