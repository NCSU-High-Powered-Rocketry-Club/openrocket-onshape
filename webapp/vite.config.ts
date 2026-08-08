import { defineConfig } from 'vite';

// GitHub Pages serves the site from a subpath: https://<org>.github.io/openrocket-onshape/
// The base must match the repository name for asset paths to resolve correctly.
export default defineConfig({
  base: '/openrocket-onshape/',
});