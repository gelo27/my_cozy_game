import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

function isLoopbackHostHeader(hostHeader: string): boolean {
  try {
    const rawHostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

/** Require a loopback Host and, when supplied by the browser, an exact same-origin match. */
function isTrustedLocalRequest(originHeader: string | undefined, hostHeader: string): boolean {
  if (!isLoopbackHostHeader(hostHeader)) return false;
  if (!originHeader) return true; // Non-browser local tools may omit Origin; the loopback peer is still required.
  try {
    const origin = new URL(originHeader);
    const requestHost = new URL(`http://${hostHeader}`);
    return origin.protocol === 'http:' && origin.origin === requestHost.origin &&
      isLoopbackHostHeader(origin.host);
  } catch {
    return false;
  }
}

/**
 * Dev-only endpoints for the in-game editor: POST /__dev/rivers writes src/world/rivers/rivers.json,
 * POST /__dev/caves writes src/explore/cave/caves.json. Only loopback clients may write (the dev
 * server listens on the LAN), the body must be the expected JSON shape, and the write does not
 * trigger a page reload (the editor already shows the new state).
 */
function devWorldDataPlugin(): Plugin {
  const files = new Map<string, { file: string; limit: number; check: (v: unknown) => boolean; what: string }>([
    ['/__dev/rivers', { file: path.resolve(__dirname, 'src/world/rivers/rivers.json'), limit: 2_000_000, check: Array.isArray, what: 'an array of rivers' }],
    [
      '/__dev/caves',
      {
        file: path.resolve(__dirname, 'src/explore/cave/caves.json'),
        limit: 12_000_000,
        check: (v) => !!v && typeof v === 'object' && (v as { version?: number }).version === 1 && Array.isArray((v as { hubs?: unknown }).hubs),
        what: 'a cave layout',
      },
    ],
  ]);
  const lastWrite = new Map<string, number>();
  return {
    name: 'dev-world-data',
    apply: 'serve',
    configureServer(server) {
      for (const [route, target] of files) {
        server.middlewares.use(route, (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Allow', 'POST');
            res.end();
            return;
          }

          const ip = req.socket.remoteAddress ?? '';
          const hostHeader = req.headers.host ?? '';
          const fetchSiteHeader = req.headers['sec-fetch-site'];
          const fetchSite = Array.isArray(fetchSiteHeader) ? fetchSiteHeader[0] : fetchSiteHeader;
          const isLoopbackPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
          if (!isLoopbackPeer || !isTrustedLocalRequest(req.headers.origin, hostHeader) ||
              (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
            res.statusCode = 403;
            res.end();
            return;
          }

          const contentType = req.headers['content-type'] ?? '';
          if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
            res.statusCode = 415;
            res.end('Expected application/json');
            return;
          }

          let body = '';
          let bodyBytes = 0;
          let tooLarge = false;
          req.on('data', (chunk) => {
            if (tooLarge) return;
            const part = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            bodyBytes += Buffer.byteLength(part, 'utf8');
            if (bodyBytes > target.limit) {
              tooLarge = true;
              body = '';
              return;
            }
            body += part;
          });
          req.on('end', () => {
            if (tooLarge) {
              res.statusCode = 413;
              res.end('Request body too large');
              return;
            }
            try {
              const parsed: unknown = JSON.parse(body);
              if (!target.check(parsed)) throw new Error(`Expected ${target.what}`);
              lastWrite.set(target.file, Date.now());
              fs.writeFileSync(target.file, body);
              res.end('ok');
            } catch {
              res.statusCode = 400;
              res.end('Invalid JSON payload');
            }
          });
          req.on('error', () => {
            if (!res.writableEnded) {
              res.statusCode = 400;
              res.end();
            }
          });
        });
      }
    },
    handleHotUpdate(ctx) {
      const file = path.resolve(ctx.file);
      if (Date.now() - (lastWrite.get(file) ?? 0) < 3000) return [];
    },
  };
}

function reloadGameModules(): Plugin {
  const source = path.resolve(__dirname, 'src');
  return {
    name: 'reload-game-modules',
    apply: 'serve',
    handleHotUpdate({ file, server }) {
      const relative = path.relative(source, file);
      if (!relative.endsWith('.ts') || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
      // Keep one module graph for the engine and its shared state. React Fast Refresh can
      // otherwise leave game systems reading different instances of the same module.
      server.moduleGraph.invalidateAll();
      server.ws.send({ type: 'full-reload', path: '*' });
      return [];
    },
  };
}

export default defineConfig(({ command }) => {
  return {
    // Production builds use relative URLs so the game also works from a sub-path
    // (GitHub Pages serves it at https://<user>.github.io/<repo>/)
    base: command === 'build' ? './' : '/',
    plugins: [react(), tailwindcss(), devWorldDataPlugin(), reloadGameModules()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        'react': path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      },
      dedupe: ['react', 'react-dom', 'react-dom/client'],
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'three',
        'three/examples/jsm/loaders/GLTFLoader.js',
        'three/examples/jsm/utils/SkeletonUtils.js',
        'three/examples/jsm/utils/BufferGeometryUtils.js',
        '@dimforge/rapier3d-compat',
        'lucide-react',
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
