/* The bundler-visible door into the gate. api/_gate.js imports THIS, so Vercel's esbuild pass traces
   through it and inlines cloudflare-pages-function.js into the function bundle — which a runtime
   readFileSync of that file can never do, because the bundled output has no repo sitting around. */
export { onRequest } from './cloudflare-pages-function.js';
