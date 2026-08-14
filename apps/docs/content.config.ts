import { defineContentConfig, defineCollection, z } from '@nuxt/content';

/**
 * One page collection per UI locale.
 *
 * The markdown tree is mirrored per locale (`content/en/**`, `content/de/**`)
 * and each collection strips its own locale directory from the generated
 * route (`prefix: ''`). That is what keeps the English URLs byte-identical to
 * the ones this site shipped with — `content/en/1.guide/2.quick-start.md` is
 * still `/guide/quick-start`, not `/en/guide/quick-start` — while the German
 * mirror produces the *same* paths and gets its `/de` segment from
 * `@nuxtjs/i18n`'s `prefix_except_default` routing instead of from the file
 * tree. Queries therefore always run against a locale-free path; only the
 * collection changes.
 *
 * `de` is a partial mirror while translation lands page by page, so every read
 * of a non-default collection falls back to `content_en` — see
 * `app/composables/useDocsContent.ts`. A missing German page renders its
 * English source, never a 404.
 */
const pageSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
});

export default defineContentConfig({
	collections: {
		content_en: defineCollection({
			type: 'page',
			source: { include: 'en/**/*.md', prefix: '' },
			schema: pageSchema,
		}),
		content_de: defineCollection({
			type: 'page',
			source: { include: 'de/**/*.md', prefix: '' },
			schema: pageSchema,
		}),
	},
});
