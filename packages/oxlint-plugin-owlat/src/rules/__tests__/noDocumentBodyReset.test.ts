import rule from '../noDocumentBodyReset.ts';
import { ruleTester } from '../../__tests__/ruleTester.ts';

const filename = 'apps/web/app/__tests__/cases.test.ts';
const scoped = [{ files: ['apps/web/**/__tests__/**', 'packages/ui/**/__tests__/**'] }];
const errors = [{ message: /Do not reset the whole document in a test/ }];

ruleTester.run('owlat/no-document-body-reset', rule, {
	valid: [
		{
			name: 'appending an owned fixture and removing it',
			filename,
			code: "const host = document.createElement('div');\nhost.innerHTML = '<p>x</p>';\ndocument.body.appendChild(host);\nhost.remove();",
		},
		{
			name: 'removing one owned child from the body',
			filename,
			code: 'declare const el: HTMLElement;\ndocument.body.removeChild(el);',
		},
		{
			name: "reading the body's markup",
			filename,
			code: "expect(document.body.innerHTML).toContain('dialog');\nconst text = document.body.textContent;",
		},
		{
			name: "clearing an element that is not the document's root",
			filename,
			code: "declare const container: HTMLElement;\ncontainer.innerHTML = '';\ncontainer.replaceChildren();",
		},
		{
			name: 'a local variable named document that is not the global',
			filename,
			code: "const document = { body: { innerHTML: '' } };\ndocument.body.innerHTML = '';",
		},
		{
			name: 'a reassigned alias, which may no longer hold the body',
			filename,
			code: "let target: HTMLElement = document.body;\ntarget = document.createElement('div');\ntarget.innerHTML = '';",
		},
		{
			name: 'a loop over the children that only reads them',
			filename,
			code: 'for (let i = 0; i < document.body.children.length; i++) expect(document.body.children[i]).toBeTruthy();',
		},
		{
			name: 'removing the nodes a targeted query finds',
			filename,
			code: "for (const el of document.body.querySelectorAll('[data-opener]')) el.remove();",
		},
		{
			name: 'a forEach over the children that does not remove them',
			filename,
			code: "Array.from(document.body.children).forEach((child) => child.setAttribute('inert', ''));",
		},
		{
			name: 'a parameter that defaults to the body, which a caller may override',
			filename,
			code: "function clear(target = document.body) { target.innerHTML = ''; }",
		},
		{
			name: 'a variable declared without an initializer',
			filename,
			code: "let target: HTMLElement;\ntarget = document.body;\ntarget.innerHTML = '';",
		},
		{
			name: 'a destructuring key the rule cannot read',
			filename,
			code: "declare const key: 'body';\nconst { [key]: target } = document;\ntarget.innerHTML = '';",
		},
		{
			name: 'a for...of over the children that removes a node found inside each child',
			filename,
			code: "for (const child of document.body.children) child.querySelector('[data-owned]')?.remove();\nfor (const child of [...document.body.children]) child.firstChild?.remove();",
		},
		{
			name: 'a forEach over the children that removes a descendant or an owned node',
			filename,
			code: "declare const owned: HTMLElement;\nArray.from(document.body.children).forEach((child) => child.querySelector('.toast')?.remove());\n[...document.body.children].forEach(() => owned.remove());\nArray.from(document.body.childNodes).forEach((node) => document.body.removeChild(owned));",
		},
		{
			name: 'a for...of over the children that removes an unrelated node or calls remove(index)',
			filename,
			code: "declare const fixtures: HTMLElement[];\nfor (const child of document.body.children) fixtures.pop()?.remove();\nfor (const select of document.body.querySelectorAll('*')) (select as HTMLSelectElement).remove(0);",
		},
		{
			name: 'a forEach over the children with a callback the rule cannot see into',
			filename,
			code: 'declare const detach: (node: Element) => void;\nArray.from(document.body.children).forEach(detach);',
		},
		{
			name: "a loop over one child's own children, which leaves every root child in place",
			filename,
			code: "for (const node of document.body.children[0].children) node.remove();\nfor (const node of document.body.firstElementChild!.childNodes) node.remove();\nArray.from(document.body.children[0].children).forEach((node) => node.remove());\nfor (const node of document.body.querySelector('main')!.querySelectorAll('*')) node.remove();",
		},
		{
			name: 'a loop over a filtered or mapped copy of the children',
			filename,
			code: "for (const node of [...document.body.children].filter((el) => el.hasAttribute('data-owned'))) node.remove();\nfor (const node of Array.from(document.body.children, (el) => el.firstElementChild!)) node.remove();\nfor (const node of [...document.body.children].map((el) => el.lastChild!)) node.remove();\n[...document.body.childNodes].slice(1).forEach((node) => node.remove());\nconst owned = [...document.body.children].filter((el) => el.matches('.toast'));\nfor (const node of owned) node.remove();",
		},
		{
			name: 'a loop over an expression that only mentions the children, or a local Array',
			filename,
			code: 'declare const pick: (nodes: HTMLCollection) => Element[];\nfor (const node of pick(document.body.children)) node.remove();\nfor (const node of document.body.children.length ? [] : [document.body]) node.remove();\nconst Array = { from: (nodes: HTMLCollection) => [nodes[0]] };\nfor (const node of Array.from(document.body.children)) node.remove();',
		},
		{
			name: 'a loop on the child count that removes owned nodes, not the root children',
			filename,
			code: "declare const owned: HTMLElement[];\nwhile (document.body.childElementCount > 1) owned.pop()?.remove();\nwhile (document.body.firstChild) document.body.firstChild.querySelector('[data-owned]')?.remove();",
		},
		{
			name: 'a file outside the configured globs',
			filename: 'packages/email-builder/src/__tests__/cases.test.ts',
			options: scoped,
			code: "document.body.innerHTML = '';",
		},
		{
			name: 'a file that never names the document',
			filename,
			code: "declare const body: { innerHTML: string };\nbody.innerHTML = '';",
		},
	],
	invalid: [
		{
			name: "the classic `document.body.innerHTML = ''` teardown",
			filename,
			code: "afterEach(() => {\n\tdocument.body.innerHTML = '';\n});",
			errors,
		},
		{
			name: 'building a fixture by overwriting the whole body',
			filename,
			code: 'document.body.innerHTML = \'<div id="section-navigation"></div>\';',
			errors,
		},
		{
			name: 'a file inside the configured globs',
			filename: 'packages/ui/composables/__tests__/cases.test.ts',
			options: scoped,
			code: "document.body.innerHTML = '';",
			errors,
		},
		{
			name: 'a computed property key',
			filename,
			code: "document.body['innerHTML'] = '';\ndocument['body'].innerHTML = '';\ndocument.body[`textContent`] = '';",
			errors: 3,
		},
		{
			name: 'textContent, innerText, outerHTML and compound assignment',
			filename,
			code: "document.body.textContent = '';\ndocument.body.innerText = '';\ndocument.documentElement.outerHTML = '<html></html>';\ndocument.body.innerHTML += '<p></p>';",
			errors: 4,
		},
		{
			name: 'the root element and global-object spellings',
			filename,
			code: "document.documentElement.innerHTML = '';\nwindow.document.body.innerHTML = '';\nglobalThis.document.body.innerHTML = '';\nself.document.body.innerHTML = '';",
			errors: 4,
		},
		{
			name: 'TypeScript wrappers around the body',
			filename,
			code: "document.body!.innerHTML = '';\n(document.body as HTMLElement).innerHTML = '';",
			errors: 2,
		},
		{
			name: 'replacing methods',
			filename,
			code: "document.body.replaceChildren();\ndocument.body.replaceChildren(fixture);\ndocument.body.setHTMLUnsafe('');\ndocument.documentElement.replaceWith(other);",
			errors: 4,
		},
		{
			name: 'an optional call on the body',
			filename,
			code: 'document.body?.replaceChildren();',
			errors,
		},
		{
			name: 'a const alias of the body or of the document',
			filename,
			code: "const body = document.body;\nbody.innerHTML = '';\nconst doc = window.document;\ndoc.body.replaceChildren();",
			errors: 2,
		},
		{
			name: 'a destructured body',
			filename,
			code: "const { body } = document;\nbody.innerHTML = '';\nconst { documentElement: root } = document;\nroot.replaceChildren();",
			errors: 2,
		},
		{
			name: 'a document destructured from a global object, and a quoted key',
			filename,
			code: "const { document: doc } = window;\ndoc.body.innerHTML = '';\nconst { 'body': target } = document;\ntarget.replaceChildren();",
			errors: 2,
		},
		{
			name: 'document and window provided as configured globals',
			filename,
			languageOptions: { globals: { document: 'readonly', window: 'readonly' } },
			code: "document.body.innerHTML = '';\nwindow.document.body.replaceChildren();",
			errors: 2,
		},
		{
			name: 'a let alias that is never reassigned',
			filename,
			code: "let body = document.body;\nbody.textContent = '';",
			errors,
		},
		{
			name: 'a while loop that drains the body',
			filename,
			code: 'while (document.body.firstChild) document.body.removeChild(document.body.firstChild);',
			errors,
		},
		{
			name: 'a do...while and a for loop that drain the body',
			filename,
			code: 'do { document.body.lastChild?.remove(); } while (document.body.hasChildNodes());\nfor (; document.body.childElementCount > 0; ) document.body.firstElementChild!.remove();',
			errors: 2,
		},
		{
			name: 'a draining loop that indexes the children or reads them through a variable',
			filename,
			code: 'while (document.body.children.length) document.body.children[0].remove();\nwhile (document.body.childNodes.length > 0) document.body.removeChild(document.body.childNodes.item(0));\nwhile (document.body.lastChild) { const last = document.body.lastChild; last.parentNode?.removeChild(last); }\nlet node: ChildNode | null;\nwhile ((node = document.body.firstChild)) node.remove();',
			errors: 4,
		},
		{
			name: 'a for...of over the children that removes them',
			filename,
			code: 'for (const child of [...document.body.children]) child.remove();\nfor (const node of Array.from(document.body.childNodes)) document.body.removeChild(node);',
			errors: 2,
		},
		{
			name: 'a for...of over the live collection, a sliced or extended copy, or an alias of one',
			filename,
			code: "declare const extra: HTMLElement;\nfor (const child of document.body.children) child.remove();\nfor (const child of [...document.body.children].slice()) child.remove();\nfor (const child of [...document.body.childNodes, extra]) child.remove();\nconst kids = Array.from(document.body.children);\nfor (const child of kids) child.remove();\nconst all = document.documentElement.querySelectorAll('*');\nall.forEach((el) => el.remove());",
			errors: 5,
		},
		{
			name: "a for...of over every descendant ('*') that removes them",
			filename,
			code: "for (const el of document.body.querySelectorAll('*')) el.remove();",
			errors,
		},
		{
			name: 'a for...of that removes the visited node through an alias, its parent or a function callback',
			filename,
			code: 'for (const child of [...document.body.children]) { const el = child as HTMLElement; el.remove(); }\nfor (const child of [...document.body.children]) child.parentElement!.removeChild(child);\nlet visited: Element;\nfor (visited of [...document.body.children]) visited.remove();\nArray.from(document.body.children).forEach(function (child) { document.body.removeChild(child); });',
			errors: 4,
		},
		{
			name: 'a forEach over the children that removes them',
			filename,
			code: 'Array.from(document.body.children).forEach((child) => child.remove());\n[...document.body.childNodes].forEach((node) => { node.parentNode?.removeChild(node); });',
			errors: 2,
		},
	],
});
