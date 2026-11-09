import { fileURLToPath } from 'node:url'

// The CLI lives in dist/bin; the vendorable bundle lives directly in dist.
export const runtimePath = fileURLToPath(new URL('../claude-compat.js', import.meta.url))
