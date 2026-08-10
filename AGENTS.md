# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup command for this project:

- codexapi service: `npm run dev:codex`
- codexapi UI: `npm run dev:codex`
- Fixed service URL: `http://127.0.0.1:3001`
- Fixed UI URL: `http://127.0.0.1:3001/`

Do not choose another port automatically. If port `3001` is busy, report the owning process and ask before stopping it or using a different port.

## Production VM

- Follow `C:\PROJECTS\ludora\ludora-admin\docs\production-deployment.md` locally or `/opt/ludora/ludora-admin/docs/production-deployment.md` on the VM for provisioning, routine deployment, rollback, and verification.
- Instance: `ludora-admin-img-20260714-105613`
- GCP project: `ludora-501213`
- Zone: `us-central1-a`
- SSH user: `robertorojas87`
- Connect with `gcloud compute ssh robertorojas87@ludora-admin-img-20260714-105613 --project ludora-501213 --zone us-central1-a`
- The previous `ludora-admin` instance in `us-central1-c` is terminated. Do not deploy to it.
- The active VM was restored from machine image `ludora-admin-img`, uses machine type `e2-small`, and currently owns the ephemeral external IP `34.55.19.20`.
- Admin checkout: `/opt/ludora/ludora-admin`
- Codex API checkout: `/opt/ludora/codexapi`
- Public admin URL: `https://admin.ludora.bobbycrimson.com`
- Admin service unit: `ludora-admin-service.service`, bound to `127.0.0.1:4001`
- Codex API unit: `codexapi.service`, bound to `127.0.0.1:3001`
- nginx serves the admin UI and proxies `/api/` to the admin service only.
- Keep Codex API loopback-only. Never add an nginx route or GCP firewall rule for port `3001`.
- The CodexAPI production service must run as the dedicated `codexapi` system user and group, with a dedicated `HOME`/`CODEX_HOME` and empty `/var/lib/codexapi/workspace` owned only by that identity. It must not run as `robertorojas87`, `mcp13`, or the Ludora admin-service identity.
- This repository change documents the intended identity boundary only. Provisioning the account, moving authentication, changing `codexapi.service`, and verification/rollback remain future deployment-runbook work; do not perform them from local development without an explicit deployment request.

Do not run DDL or DML SQL commands without user confirmation.
