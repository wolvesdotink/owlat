/**
 * Register the built-in Block modules with the module registry.
 *
 * Side-effect import: pulling this file in registers every shipped block
 * module. Lives in its own file so the registration list is grep-able and the
 * blocks/index.ts walker stays free of explicit per-block imports.
 *
 * Hosts that want custom blocks call `registerBlockModule(myModule)` after
 * this file has run but before `finalizeBlockRegistry()`.
 */

import { registerBlockModule } from './_registry';
import { dividerModule } from './divider';
import { spacerModule } from './spacer';
import { rawHtmlModule } from './rawHtml';
import { textModule } from './text';
import { imageModule } from './image';
import { listModule } from './list';
import { buttonModule } from './button';
import { socialModule } from './social';
import { menuModule } from './menu';
import { progressBarModule } from './progressBar';
import { videoModule } from './video';
import { accordionModule } from './accordion';
import { carouselModule } from './carousel';
import { tableModule } from './table';
import { columnsModule } from './columns';
import { containerModule } from './container';
import { heroModule } from './hero';

registerBlockModule(dividerModule);
registerBlockModule(spacerModule);
registerBlockModule(rawHtmlModule);
registerBlockModule(textModule);
registerBlockModule(imageModule);
registerBlockModule(listModule);
registerBlockModule(buttonModule);
registerBlockModule(socialModule);
registerBlockModule(menuModule);
registerBlockModule(progressBarModule);
registerBlockModule(videoModule);
registerBlockModule(accordionModule);
registerBlockModule(carouselModule);
registerBlockModule(tableModule);
registerBlockModule(columnsModule);
registerBlockModule(containerModule);
registerBlockModule(heroModule);
