import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
    root: 'src',
    base: './',
    plugins: [preact()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
        outDir: '../app',
        emptyOutDir: true,
        target: 'es2020',
        modulePreload: false,
        assetsInlineLimit: 0,
    },
});
