# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup command for this project:

- codexapi service: `npm run dev:codex`
- codexapi UI: `npm run dev:codex`
- Fixed service URL: `http://127.0.0.1:3001`
- Fixed UI URL: `http://127.0.0.1:3001/`

Do not choose another port automatically. If port `3001` is busy, report the owning process and ask before stopping it or using a different port.

## Production VM

- Instance: `ludora-admin`
- GCP project: `ludora-501213`
- Zone: `us-central1-c`
- SSH user: `robertorojas87`
- Connect with `gcloud compute ssh robertorojas87@ludora-admin --project ludora-501213 --zone us-central1-c`
- Admin checkout: `/opt/ludora/ludora-admin`
- Codex API checkout: `/opt/ludora/codexapi`
- Run application services as `robertorojas87`.
- Do not use the automatically created `mcp13` account for deployment or service ownership.

Do not run DDL or DML SQL commands without user confirmation.
