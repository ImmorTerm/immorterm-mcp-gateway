# Workflow Notes

## npm Trusted Publishing must be re-pointed (founder action)

`.github/workflows/publish.yml` publishes `immorterm-mcp-gateway` to npm using
**Trusted Publishing** (OIDC, `--provenance`, no `NODE_AUTH_TOKEN`). Trusted
Publishing binds a package to a specific **repository + workflow file**.

The package `immorterm-mcp-gateway` was previously published from the monorepo
(`lonormaly/ImmorTerm`, workflow `.github/workflows/20-promote-prod.yml`, job
`promote-gateway`). Until the trusted publisher is re-pointed, the first publish
from this repo will fail with an OIDC/authorization error.

**Founder must, on npmjs.com → `immorterm-mcp-gateway` → Settings → Trusted Publishing:**

1. Remove (or leave) the old publisher pointing at `lonormaly/ImmorTerm`.
2. Add a new trusted publisher:
   - **Repository**: `ImmorTerm/immorterm-mcp-gateway`
   - **Workflow filename**: `publish.yml`
   - **Environment**: (leave blank — this workflow does not use a GH environment)

Once re-pointed, run the **Publish to npm** workflow (`workflow_dispatch`) from
the Actions tab. It bumps the patch version, builds, tests, and publishes.

## Notes on the port from the monorepo lane

- The original lane used `bun install` in a monorepo working directory. This
  standalone repo uses `npm install` at the repo root (deps are plain npm; no
  workspace/`@immorterm/*` packages — the gateway is fully self-contained).
- Version bump reads the live npm version first (`npm view ... version`) and
  falls back to `package.json`, so it stays monotonic even if `package.json`
  drifts.
- `npm test` runs the vitest suite before publish. Remove that step only if the
  suite ever becomes environment-dependent in CI.
