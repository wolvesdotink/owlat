/**
 * Side-effect registry of the 17 built-in Editor modules. Importing this file
 * registers every built-in block with the typed registry. Mirrors
 * `email-renderer/src/blocks/_builtin-modules.ts` on the builder side.
 *
 * Authors of a new built-in block: create
 * `packages/email-builder/src/blocks/<type>/index.ts`, then add a
 * `registerEditorModule(<typeEditor>)` line below. The typed `EditorModuleMap`
 * (`./_module.ts`) makes a missing entry a compile error at the consumption
 * site.
 */

import { registerEditorModule } from './_registry';

import { textEditor } from './text';
import { imageEditor } from './image';
import { buttonEditor } from './button';
import { dividerEditor } from './divider';
import { spacerEditor } from './spacer';
import { columnsEditor } from './columns';
import { socialEditor } from './social';
import { containerEditor } from './container';
import { heroEditor } from './hero';
import { tableEditor } from './table';
import { rawHtmlEditor } from './rawHtml';
import { videoEditor } from './video';
import { accordionEditor } from './accordion';
import { menuEditor } from './menu';
import { carouselEditor } from './carousel';
import { listEditor } from './list';
import { progressBarEditor } from './progressBar';

registerEditorModule(textEditor);
registerEditorModule(imageEditor);
registerEditorModule(buttonEditor);
registerEditorModule(dividerEditor);
registerEditorModule(spacerEditor);
registerEditorModule(columnsEditor);
registerEditorModule(socialEditor);
registerEditorModule(containerEditor);
registerEditorModule(heroEditor);
registerEditorModule(tableEditor);
registerEditorModule(rawHtmlEditor);
registerEditorModule(videoEditor);
registerEditorModule(accordionEditor);
registerEditorModule(menuEditor);
registerEditorModule(carouselEditor);
registerEditorModule(listEditor);
registerEditorModule(progressBarEditor);
