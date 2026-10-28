import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  publicDir: false,
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  build: {
    outDir: 'capacitor-www',
    emptyOutDir: true,
  },
  plugins: [{
    name: 'disable-service-worker-in-capacitor',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
      const withoutServiceWorker = html.replace(
        /\n<script>\s*if \('serviceWorker' in navigator\)[\s\S]*?<\/script>\s*\n(?=<\/body>)/,
        '\n',
      );
      return withoutServiceWorker.replace(
        '<head>',
        '<head>\n<script type="module">import { Capacitor } from "@capacitor/core"; window.Capacitor = Capacitor;</script>',
      );
      },
    },
  }],
});
