# Simple server deployment

The operator already has an HTTPS reverse proxy. Make installation and repeated updates work with Git, Docker Engine and Compose v2 only; Node/npm belongs inside the build container. Keep the existing Compose project and named database volume so registrations survive deployment changes.

Provide a POSIX `./handoff` helper: `setup HTTPS_ORIGIN` writes a minimal ignored `.env` and starts a healthy backend, `up` rebuilds current source, `update` fast-forwards a clean Git checkout and runs the updated helper, `status`, `logs`, and `stop` handle daily operations. Never remove volumes or overwrite existing configuration. Reject malformed input before writing config. Default to loopback, with an explicit bind option for a separate proxy host and an external Docker network option for a containerized proxy. Setup and rebuild errors must return nonzero and provide diagnostics.

Use the existing source build rather than adding a registry dependency. Build only the backend in Docker and cache dependency installation. Add a short deployment guide with copyable commands, upstream/WebSocket instructions, health checks and update behavior. Preserve the optional standalone Caddy deployment and the signed extension release unchanged.

Verify CLI behavior with automated tests and the real setup/rebuild/stop workflow with an isolated Compose project. The runtime test must verify an authenticated device survives container recreation. Actual server DNS/TLS and Google Admin devices remain operator validation.
