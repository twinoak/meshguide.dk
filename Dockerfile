FROM php:8.3-cli

# APCu so local development matches the server (incl. the cache path in api/scopes.php).
RUN apt-get update \
 && apt-get install -y --no-install-recommends $PHPIZE_DEPS \
 && pecl install apcu \
 && docker-php-ext-enable apcu \
 && apt-get purge -y --auto-remove $PHPIZE_DEPS \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PHP's built-in server serves the static files AND runs .php - same as
# production, without nginx/fpm. apc.enable_cli=1 is required: APCu is disabled
# under the CLI SAPI by default, and the built-in server runs as CLI, so without
# the flag the cache never engages.
#
# Bind to [::] (dual-stack): an IPv6 socket on Linux accepts both IPv6 and
# IPv4-mapped connections, so both localhost (::1) and 127.0.0.1 hit.
CMD ["php", "-d", "apc.enable_cli=1", "-S", "[::]:8000", "router.php"]
