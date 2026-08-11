#!/bin/sh
# Local development server: builds the image (near-instant when cached) and
# serves the whole site on http://localhost:8000. Only requires 'podman'.
#
# The repo is bind-mounted into the container, so changes to script.js,
# api/scopes.php or the JSON files take effect by reloading the browser.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
podman build -t mcdk-dev "$ROOT"
# --network=host: the container binds the host's port directly, without rootless
# port forwarding (pasta) - avoids IPv4/IPv6 mismatches on loopback.
exec podman run --rm --network=host -v "$ROOT":/app:Z mcdk-dev
