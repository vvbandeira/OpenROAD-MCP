---
name: docker-orfs
description: |
  Run OpenROAD/ORFS inside the official openroad/orfs Docker image via the
  openroad-mcp server, for users who don't have OpenROAD or ORFS installed
  locally.

  Use this skill whenever the user asks to:
  - Run OpenROAD in Docker, or use the openroad/orfs Docker image
  - Try openroad-mcp without installing OpenROAD/ORFS locally
  - Pull the openroad/orfs image
  - Start a Docker-backed OpenROAD session

  Trigger on phrases like "I don't have OpenROAD installed", "run this in
  Docker", "use the docker image for ORFS", or any mention of running
  OpenROAD/ORFS via Docker instead of a local install.
---

# Docker-backed OpenROAD Sessions

This skill drives OpenROAD inside the official `openroad/orfs` Docker image
through the `openroad-mcp` server's Docker-backed session tools, instead of
requiring a local `openroad` binary. The resulting session is a normal
interactive session — every other `openroad-mcp` tool (`interactive_openroad_query`,
`interactive_openroad_exec`, `get_session_history`, `get_session_metrics`,
`terminate_interactive_session`, `list_report_images`, `read_report_image`)
works with it exactly as it would with a locally-run OpenROAD process.

## Prerequisites

- Docker must be installed and the daemon reachable. Check with:
  ```bash
  docker info
  ```
  If this fails, tell the user to install/start Docker before continuing.
- `OPENROAD_ALLOWED_COMMANDS` must include `docker` (the Claude Code Plugin
  sets this by default; a manual `npx -y openroad-mcp` install needs
  `OPENROAD_ALLOWED_COMMANDS=openroad,docker` set explicitly). If
  `create_docker_orfs_session` returns a `CommandBlocked`/not-allowed error,
  this is almost always why — point the user at this env var.
- A local directory to mount as the ORFS flow directory (`flow_dir`). This
  defaults to the server's `ORFS_FLOW_PATH` (`~/OpenROAD-flow-scripts/flow`
  unless overridden). Create it first if it doesn't exist yet
  (`mkdir -p ~/OpenROAD-flow-scripts/flow`) — ORFS writes run outputs and
  reports there, and `list_report_images`/`read_report_image` read from the
  same path afterward.

## Workflow

1. **Pull the image** (first run only; large image, can take several
   minutes):
   ```
   pull_orfs_docker_image
   ```
   Pass `image` to pin a different tag if the user asks for one; otherwise
   the default tag matches this server's pinned ORFS version.

2. **Create the session**:
   ```
   create_docker_orfs_session
   ```
   Pass `flow_dir` if the user's ORFS checkout lives somewhere other than
   the default. Capture the returned `session_id` — reuse it for every
   subsequent call so you don't accumulate sessions (same rule as
   `create_interactive_session`; see [docs/API.md](../../docs/API.md#session-lifecycle-notes)).

3. **Drive it like any other session**, using `session_id` from step 2:
   - `interactive_openroad_query` for read-only commands (`report_*`,
     `get_*`, `check_*`, `sta`, `help`, `version`, …)
   - `interactive_openroad_exec` for state-modifying commands (loading a
     design, running flow stages, writing output)
   - `get_session_history` / `get_session_metrics` / `inspect_interactive_session`
     for progress and diagnostics
   - `list_report_images` / `read_report_image` once a flow stage has
     produced reports — these read from the same host `flow_dir` the
     container wrote into, so nothing extra is needed here

4. **Clean up** when done:
   ```
   terminate_interactive_session
   ```
   The container was started with `--rm`, so terminating the session also
   removes it — no leftover container to clean up manually.

## Notes

- The container runs with `--network none` by default (no network access
  inside the container). Only pass `network: true` to
  `create_docker_orfs_session` if the user's flow genuinely needs it (e.g.
  fetching a remote PDK) and they understand that removes this isolation —
  see [docs/SECURITY.md](../../docs/SECURITY.md#docker-backed-sessions).
- This targets the common case where `openroad-mcp` itself runs on the host
  (via `npx`, including when launched by this plugin) and talks to the
  host's Docker daemon directly. It does not cover running `openroad-mcp`
  itself inside `ghcr.io/the-openroad-project/openroad-mcp` while also
  orchestrating sibling containers from there (Docker-outside-of-Docker).
