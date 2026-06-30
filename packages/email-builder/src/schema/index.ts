/**
 * Schema registry — maps block types to their attribute schemas.
 *
 * Schemas are registered at import time (side-effect) from ./definitions/*.
 * The registry is consumed by PropertyPanel to dynamically render controls.
 */
import type { BlockAttributeSchema } from './types';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const schemas = new Map<string, BlockAttributeSchema>();

/**
 * Register a block attribute schema.
 */
export function registerSchema(schema: BlockAttributeSchema): void {
	schemas.set(schema.type, schema);
}

/**
 * Look up a schema by block type.
 */
export function getSchema(type: string): BlockAttributeSchema | undefined {
	return schemas.get(type);
}

/**
 * All registered schemas.
 */
export function getAllSchemas(): BlockAttributeSchema[] {
	return [...schemas.values()];
}

// ---------------------------------------------------------------------------
// Auto-register all block schemas
// ---------------------------------------------------------------------------
import { textSchema } from './definitions/text';
import { imageSchema } from './definitions/image';
import { buttonSchema } from './definitions/button';
import { dividerSchema } from './definitions/divider';
import { spacerSchema } from './definitions/spacer';
import { columnsSchema } from './definitions/columns';
import { socialSchema } from './definitions/social';
import { containerSchema } from './definitions/container';
import { heroSchema } from './definitions/hero';
import { tableSchema } from './definitions/table';
import { rawHtmlSchema } from './definitions/rawHtml';
import { videoSchema } from './definitions/video';
import { accordionSchema } from './definitions/accordion';
import { menuSchema } from './definitions/menu';
import { carouselSchema } from './definitions/carousel';
import { listSchema } from './definitions/list';
import { progressBarSchema } from './definitions/progressBar';
registerSchema(textSchema);
registerSchema(imageSchema);
registerSchema(buttonSchema);
registerSchema(dividerSchema);
registerSchema(spacerSchema);
registerSchema(columnsSchema);
registerSchema(socialSchema);
registerSchema(containerSchema);
registerSchema(heroSchema);
registerSchema(tableSchema);
registerSchema(rawHtmlSchema);
registerSchema(videoSchema);
registerSchema(accordionSchema);
registerSchema(menuSchema);
registerSchema(carouselSchema);
registerSchema(listSchema);
registerSchema(progressBarSchema);

// Re-export types
export type { BlockAttributeSchema, PropertyGroup, PropertyField, FieldType } from './types';

// Toolbar helpers
export { getToolbarFields } from './toolbar';
