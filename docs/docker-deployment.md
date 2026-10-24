# Deploy behind your existing HTTPS proxy

The server needs **Git, Docker Engine and Docker Compose v2**. Node/npm runs inside the Docker build. The initial build downloads dependencies; later builds reuse Docker's cache. The backend needs one container and a persistent SQLite volume.

## First install

Clone the public repository on your server:

```sh
git clone https://github.com/CyganTech/classroom-handoff.git
cd classroom-handoff
```

Replace the sample HTTPS address below with the address you will configure in your proxy. Use an origin only, without a path or trailing slash. Choose the setup command matching your proxy:

| Your proxy | Setup command | Proxy upstream |
| --- | --- | --- |
| Runs directly on this Docker host | `./handoff setup https://handoff.example.org` | `http://127.0.0.1:8787` |
| Runs in Docker on this host | `./handoff setup https://handoff.example.org --network YOUR_PROXY_NETWORK` | `http://classroom-handoff:8787` |
| Runs on another server | `./handoff setup https://handoff.example.org --bind YOUR_DOCKER_HOST_LAN_IP` | `http://YOUR_DOCKER_HOST_LAN_IP:8787` |

For a containerized proxy, use a Docker network the proxy already joins (`docker network ls` lists names). Setup attaches the backend to that existing network with the hostname `classroom-handoff`. `127.0.0.1` inside a proxy container refers to that proxy container, so use the network hostname above. Use this alias for one Handoff stack per proxy network.

For a separate proxy server, replace `YOUR_DOCKER_HOST_LAN_IP` with the Docker host's numeric IPv4 address, such as `192.168.1.20`. Restrict access to that HTTP port to your trusted proxy/network. The default loopback binding keeps the port private to the host. `--bind 0.0.0.0` is also accepted when you deliberately need all IPv4 interfaces. Setup accepts a DNS name or IPv4 address for the public origin.

Add `--port 9876` if host port 8787 is already in use. For a Docker network upstream, the internal port remains 8787.

Setup writes `.env`, builds the image, starts the container and waits for its health check. **An existing `.env` is never overwritten.** If you previously copied `.env.example`, edit `PUBLIC_URL`, `BIND_ADDRESS` and `PORT` there, then run `./handoff up`. To join a proxy network with an existing `.env`, also add:

```dotenv
PROXY_NETWORK=YOUR_PROXY_NETWORK
COMPOSE_FILE=compose.yaml:compose.proxy.yaml
```

If setup fails, it keeps configuration and database data. Fix the reported issue and retry `./handoff up`.

## Proxy configuration and first check

Configure the proxy with:

- Public host: your HTTPS address, with a certificate trusted by both browsers.
- Upstream: the HTTP address in the table above.
- Forward the entire host, including `/api/*`, `/ws` and `/healthz`; no subpath prefix.
- Enable WebSocket upgrades. For Nginx Proxy Manager, turn on **Websockets Support**. Caddy's `reverse_proxy` handles upgrades automatically.
- Allow at least 90 seconds of idle time on WebSocket connections. The application sends heartbeats every 20 seconds by default.

For a Caddy proxy on the same host, the site configuration can be:

```caddyfile
handoff.example.org {
    reverse_proxy 127.0.0.1:8787
}
```

For Nginx, add this `map` in the `http` context and this location to your existing HTTPS server block. Adapt the upstream for your arrangement:

```nginx
# http context:
map $http_upgrade $handoff_connection {
    default upgrade;
    '' close;
}

# Inside your existing HTTPS server block:
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $handoff_connection;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}
```

After configuring DNS/proxy/TLS, check the public endpoint:

```sh
curl --fail https://handoff.example.org/healthz
./handoff status
```

The helper confirms **container health**; the public curl also checks your real proxy and TLS path. Set this same HTTPS origin as `BackendUrl` in the [Google Admin installation page](https://cygantech.github.io/classroom-handoff/), then install on two browsers and pair them. See [managed deployment](managed-deployment.md) for details.

## Iterate on the server

```sh
./handoff update  # Pull the tracked branch and rebuild; wait for healthy
./handoff logs    # Follow backend logs; Ctrl-C exits the log viewer
./handoff status  # Container state and published port
./handoff stop    # Stop/remove containers while keeping the data volume
./handoff up      # Build and start from the files currently on disk
```

`update` accepts only a clean checkout with a tracked upstream and uses `git pull --ff-only`. It never resets edits or resolves conflicts automatically. Commit/stash your edits before updating, or use `up` to test edits already on the server. `.env` and generated files are ignored by Git. Use `git switch --track origin/YOUR_BRANCH` to test a different published branch, then run `up`; subsequent `update` follows that branch.

Rebuilds briefly disconnect browsers; they reconnect automatically. Containers are recreated with the same named volume, preserving device registrations and pairings. Backend-only updates do not require reinstalling the extension. Extension code changes still need a new signed extension version and Google Admin update delivery.

Docker Compose picks up `.env` automatically; exported shell variables take precedence. Keep this clone in the same directory and retain its Compose project name so Compose uses the same database volume. If you deployed previously using `-p NAME`, export `COMPOSE_PROJECT_NAME=NAME` before using the helper. Do not run both the standalone Caddy stack and this stack for the same installation.

If a rebuild fails, read the reported logs, fix it and rerun `up`. The helper returns a nonzero exit code and does not report healthy. Check the existing container with `status`; a failed deployment is not an automatic rollback. No command in the helper deletes volumes. Back up the volume with the backend stopped before changes that need a rollback; do not use `docker compose down -v` unless you intend to erase pairings.

## Other deployment options

For localhost development, `docker compose up -d --build --wait` works without configuration at `http://localhost:8787`. The deployment helper intentionally requires HTTPS for server setup.

For automatic HTTPS without an existing proxy, use the separate `compose.production.yaml` and [Caddy instructions in the README](../README.md#automatic-https-with-caddy). That file is standalone; do not merge it with `compose.yaml`.

The helper uses standard Compose files, so direct Compose commands and Git-based stack managers can use the same files and environment settings. Neither a registry account nor access to an extension signing key is needed on the Docker server.
