#!/bin/sh
# Lokal udviklingsserver: bygger imaget (near-instant når det er cachet) og
# serverer hele siden på http://localhost:8000. Kræver kun 'podman'.
#
# Repoet bind-mountes ind i containeren, så ændringer i script.js,
# api/scopes.php eller JSON-filerne slår igennem ved at genindlæse browseren.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
podman build -t mcdk-dev "$ROOT"
# --network=host: containeren binder værtens port direkte, uden rootless
# port-forwarding (pasta) - undgår IPv4/IPv6-uoverensstemmelser på loopback.
exec podman run --rm --network=host -v "$ROOT":/app:Z mcdk-dev
