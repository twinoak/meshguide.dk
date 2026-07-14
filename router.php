<?php
// Router til PHP's indbyggede server - KUN lokal udvikling. I produktion
// klarer Apache den pæne URL via en RewriteRule; her kortlægger vi
// /api/<navn> til api/<navn>.php (fx /api/scopes -> api/scopes.php,
// /api/chats -> api/chats.php) og lader alt andet blive serveret som
// statiske filer (return false).
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/([a-z0-9_-]+)$#', $path, $m)) {
    $file = __DIR__ . '/api/' . $m[1] . '.php';
    if (is_file($file)) {
        require $file;
        return true;
    }
}
return false;
