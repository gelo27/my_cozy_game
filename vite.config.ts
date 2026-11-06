import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

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
          const ip = req.socket.remoteAddress ?? '';
          if (req.method !== 'POST' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
            res.statusCode = 403;
            res.end();
            return;
          }
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > target.limit) req.destroy();
          });
          req.on('end', () => {
            try {
              if (!target.check(JSON.parse(body))) throw new Error(`Expected ${target.what}`);
              lastWrite.set(target.file, Date.now());
              fs.writeFileSync(target.file, body);
              res.end('ok');
            } catch (err) {
              res.statusCode = 400;
              res.end(String(err));
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

export default defineConfig(({ command }) => {
  return {
    // Production builds use relative URLs so the game also works from a sub-path
    // (GitHub Pages serves it at https://<user>.github.io/<repo>/)
    base: command === 'build' ? './' : '/',
    plugins: [react(), tailwindcss(), devWorldDataPlugin()],
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
