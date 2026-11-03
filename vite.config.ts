import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

/**
 * Dev-only endpoint for the in-game editor: POST /__dev/rivers writes src/world/rivers/rivers.json.
 * Only loopback clients may write (the dev server listens on the LAN), the body must be a JSON
 * array, and the write does not trigger a page reload (the editor already shows the new state).
 */
function devWorldDataPlugin(): Plugin {
  const riversFile = path.resolve(__dirname, 'src/world/rivers/rivers.json');
  let lastWrite = 0;
  return {
    name: 'dev-world-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/rivers', (req, res) => {
        const ip = req.socket.remoteAddress ?? '';
        if (req.method !== 'POST' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            if (!Array.isArray(JSON.parse(body))) throw new Error('Expected an array of rivers');
            lastWrite = Date.now();
            fs.writeFileSync(riversFile, body);
            res.end('ok');
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
    handleHotUpdate(ctx) {
      if (path.resolve(ctx.file) === riversFile &&Date.now() - lastWrite < 3000) return [];
    },
  };
}

export default defineConfig(() => {
  return {
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
