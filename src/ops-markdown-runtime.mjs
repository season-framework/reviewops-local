import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/contextmenu/register';

self.MonacoEnvironment={...self.MonacoEnvironment,getWorker:()=>new EditorWorker()};
export {monaco};
