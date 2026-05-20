## Cursor Cloud specific instructions

### Overview

Nexus/Harvester is a React 18 + TypeScript + Vite front-end for Kubernetes manifest generation. No backend services required.

### Quick reference

- **Install**: `npm install`
- **Dev server**: `npm run dev` (serves on http://localhost:4173)
- **Build**: `npm run build` (runs `tsc` then `vite build`)
- **Type-check**: `npx tsc --noEmit`

### Gotchas

- The Vite dev server listens on port 4173 (configured in vite.config.ts), not the default 5173.
- No lint or test scripts are configured in `package.json`. Type-checking via `tsc --noEmit` is the main code quality check.
