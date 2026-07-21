import { mutationGeneric, queryGeneric } from 'convex/server';
import { v } from 'convex/values';

export const put = mutationGeneric({
	args: { value: v.string() },
	handler: async (ctx, args) => ctx.db.insert('records', { value: args.value }),
});

export const list = queryGeneric({
	args: {},
	handler: async (ctx) => ctx.db.query('records').take(10),
});
