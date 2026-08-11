<?php
// Router for PHP's built-in server - LOCAL development ONLY. In production
// Apache handles the pretty URL via a RewriteRule; here we map
// /api/<name> to api/<name>.php (e.g. /api/scopes -> api/scopes.php,
// /api/chats -> api/chats.php) and let everything else be served as
// static files (return false).
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/([a-z0-9_-]+)$#', $path, $m)) {
    $file = __DIR__ . '/api/' . $m[1] . '.php';
    if (is_file($file)) {
        require $file;
        return true;
    }
}
return false;
