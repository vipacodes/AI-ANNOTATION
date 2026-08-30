/* The bundler-visible edge. Vercel's @vercel/node builder emits a function artifact that contains
   api/index.js plus whatever it can follow through require/import — the rest of the repository is not
   necessarily there at runtime, and this project's gate lives two directories away from the entry point.

   So the link has to be a *literal, static* require from a file the builder reads: esbuild resolves it at
   build time and inlines the Cloudflare module, ESM syntax included (it transpiles `export … from`
   rather than handing it to Node's CommonJS loader, which would throw). api/_gate.js requires this file
   inside a try/catch, so a runtime that has the tree and no bundler simply falls through to reading the
   source directly. Nothing else imports this file; if you are reading it wondering, that is why. */
export { onRequest } from '../deploy/cloudflare-pages-function.js';
