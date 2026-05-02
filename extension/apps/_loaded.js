/**
 * Static plugin handler registry.
 *
 * MV3 service workers cannot use dynamic `import()` (disallowed by the HTML
 * spec — see https://github.com/w3c/ServiceWorker/issues/1356), so we
 * cannot discover and load plugin handlers purely at runtime. Instead, this
 * file statically imports the `register` function from each installed
 * plugin's `handlers.js` and exports a map keyed by plugin id.
 *
 * The plugin-loader at SW boot:
 *   1. Reads `apps/index.json` to know which plugins should be active
 *   2. Validates each plugin's `manifest.json`
 *   3. Looks up the registrar in PLUGIN_REGISTRARS by id
 *   4. Calls `registrar(handlers, { manifest })`
 *
 * Adding a plugin:
 *   1. Drop the plugin into `extension/apps/<id>/`
 *   2. Add the id to `extension/apps/index.json`
 *   3. Add a static import + entry below (this file)
 *
 * Plugin assemble scripts (e.g., horsebread's `scripts/assemble.sh`) edit
 * this file as part of the install. The reference plugin `hello-runtime`
 * is checked in by default.
 *
 * If the build process matures we can have a generator script that emits
 * this file from `apps/index.json`. For now, edit by hand — there are at
 * most a few plugins.
 */

import { register as registerHelloRuntime } from './hello-runtime/handlers.js';
import { register as registerSqliteQuery } from './sqlite-query/handlers.js';
import { register as registerCsvAnalyzer } from './csv-analyzer/handlers.js';
import { register as registerPfTextConverter } from './pf-text-converter/handlers.js';
import { register as registerPfResumeParser } from './pf-resume-parser/handlers.js';
import { register as registerPfHelloWorld } from './pf-hello-world/handlers.js';
import { register as registerPfJudge } from './pf-judge/handlers.js';
import { register as registerPfMajorityVote } from './pf-majority-vote/handlers.js';

export const PLUGIN_REGISTRARS = {
  'hello-runtime': registerHelloRuntime,
  'sqlite-query': registerSqliteQuery,
  'csv-analyzer': registerCsvAnalyzer,
  'pf-text-converter': registerPfTextConverter,
  'pf-resume-parser': registerPfResumeParser,
  'pf-hello-world': registerPfHelloWorld,
  'pf-judge': registerPfJudge,
  'pf-majority-vote': registerPfMajorityVote,
};
