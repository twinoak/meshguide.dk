<?php
// Router til PHP's indbyggede server - KUN lokal udvikling. I produktion
// klarer Apache den pæne URL via en RewriteRule; her kortlægger vi
// /api/scopes til api/scopes.php og lader alt andet blive serveret som
// statiske filer (return false).
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/api/scopes') {
    require __DIR__ . '/api/scopes.php';
    return true;
}
return false;
