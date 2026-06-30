# AGENTS.md

## Fixed Local Ports

Use the fixed Codex startup command for this project:

- codexapi service: `npm run dev:codex`
- codexapi UI: `npm run dev:codex`
- Fixed service URL: `http://127.0.0.1:3001`
- Fixed UI URL: `http://127.0.0.1:3001/`

Do not choose another port automatically. If port `3001` is busy, report the owning process and ask before stopping it or using a different port.

Do not run DDL or DML SQL commands without user confirmation.
