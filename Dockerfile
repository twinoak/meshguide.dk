FROM php:8.3-cli

# APCu så lokal udvikling matcher serveren (inkl. cache-stien i api/scopes.php).
RUN apt-get update \
 && apt-get install -y --no-install-recommends $PHPIZE_DEPS \
 && pecl install apcu \
 && docker-php-ext-enable apcu \
 && apt-get purge -y --auto-remove $PHPIZE_DEPS \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PHP's indbyggede server serverer de statiske filer OG kører .php - samme som
# produktion, uden nginx/fpm. apc.enable_cli=1 er nødvendig: APCu er slået fra
# under CLI-SAPI'en som standard, og den indbyggede server kører som CLI, så
# uden flaget engagerer cachen aldrig.
#
# Bind til [::] (dual-stack): en IPv6-socket på Linux accepterer både IPv6 og
# IPv4-mappede forbindelser, så både localhost (::1) og 127.0.0.1 rammer.
CMD ["php", "-d", "apc.enable_cli=1", "-S", "[::]:8000"]
