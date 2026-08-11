<?php
// chats.php - lookup in the city/chat registry (cities.json).
//
// GET /api/chats?all           -> all chats as a list
// GET /api/chats?chat=<name>   -> a single chat
//
// Chats come from two sources: the hand-curated city chats in cities.json, AND
// a derived chat per postal code - each postal code (dk5000, dk5230, …) has its
// own chat room #dk5000 with scope dk5000 and a centroid Point as its location.
//
// <name> matches the chat's key ("odense"), its handle ("#dk-fyn-odense", with
// or without #) or its name ("Odense") - case-insensitive. Postal code chats
// are looked up by "dk5000", "#dk5000" or just "5000". The short form
// /api/chats?odense also works.
//
// cities.json and the postal code files are the same data the rest of the site
// uses; this endpoint exposes them as an API, so a node can look up a single
// chat without fetching and parsing the entire dataset.

declare(strict_types=1);

// --- HTTP scaffolding ------------------------------------------------------

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => $msg], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// --- Data loading (APCu-cached, mtime-keyed - same pattern as scopes.php) --

function get_chats(string $root): array {
    $path = $root . '/cities.json';
    $key  = 'mcdk:chats:' . md5($path . ':' . (@filemtime($path) ?: 0));

    $haveApcu = function_exists('apcu_fetch');
    if ($haveApcu) {
        $cached = apcu_fetch($key, $ok);
        if ($ok) return $cached;
    }

    $raw = @file_get_contents($path);
    if ($raw === false) fail(500, 'could not read cities.json');
    $chats = json_decode($raw, true);
    if (!is_array($chats)) fail(500, 'cities.json is not valid JSON');

    if ($haveApcu) apcu_store($key, $chats, 3600);
    return $chats;
}

// Flat entry -> key-tagged object, so the client knows the chat's id.
function chat_entry(string $key, array $v): array {
    return array_merge(['key' => $key], $v);
}

// Bbox for a Polygon/MultiPolygon as [minx, miny, maxx, maxy], or null.
function geom_bbox(?array $geom): ?array {
    if (!$geom) return null;
    $type = $geom['type'] ?? '';
    $rings = [];
    if ($type === 'Polygon') {
        $rings = $geom['coordinates'];
    } elseif ($type === 'MultiPolygon') {
        foreach ($geom['coordinates'] as $poly) foreach ($poly as $ring) $rings[] = $ring;
    } else {
        return null;
    }
    $minx = INF; $miny = INF; $maxx = -INF; $maxy = -INF;
    foreach ($rings as $ring) {
        foreach ($ring as $pt) {
            $x = $pt[0]; $y = $pt[1];
            if ($x < $minx) $minx = $x;
            if ($x > $maxx) $maxx = $x;
            if ($y < $miny) $miny = $y;
            if ($y > $maxy) $maxy = $y;
        }
    }
    if (!is_finite($minx)) return null;
    return [$minx, $miny, $maxx, $maxy];
}

// One derived chat per postal code scope. Each postal code is expanded into
// its prefix layers using the same layer convention as scopes.php (dk5230 ->
// dk5, dk52, dk523, dk5230), so the aggregate chat rooms (e.g. dk50, covering
// all of 50xx) are included too. Each postal code's bbox is merged into all of
// its layers, so an aggregate room gets the centroid Point for the center of
// ALL its postal codes. Loads the postal code files via the manifest and caches
// the derived result in APCu, keyed on the files' mtime - like scopes.php, so a
// git pull invalidates the cache automatically.
function get_postal_chats(string $root): array {
    $manifestPath = $root . '/postnumre/index.json';
    $manifestRaw = @file_get_contents($manifestPath);
    $manifest = $manifestRaw !== false ? json_decode($manifestRaw, true) : ['files' => []];
    $files = $manifest['files'] ?? [];

    $paths = [$manifestPath];
    foreach ($files as $f) $paths[] = $root . '/postnumre/' . $f['file'];
    $sig = '';
    foreach ($paths as $p) $sig .= $p . ':' . (@filemtime($p) ?: 0) . ';';
    $key = 'mcdk:postal_chats:' . md5($sig);

    $haveApcu = function_exists('apcu_fetch');
    if ($haveApcu) {
        $cached = apcu_fetch($key, $ok);
        if ($ok) return $cached;
    }

    // Collect (merged) bbox per scope key across all prefix layers.
    $bb = [];
    $seenLeaf = [];
    foreach ($files as $f) {
        $raw = @file_get_contents($root . '/postnumre/' . $f['file']);
        if ($raw === false) continue;
        $d = json_decode($raw, true);
        if (!is_array($d)) continue;
        foreach ($d as $k => $v) {
            if (!preg_match('/^dk(\d{4})$/', $k, $m)) continue;
            if (isset($seenLeaf[$k])) continue;       // first file wins (like scopes.php)
            $seenLeaf[$k] = true;
            $box = geom_bbox($v['geometry'] ?? null);
            if (!$box) continue;
            $digits = $m[1];
            $layers = ['dk' . $digits[0], 'dk' . substr($digits, 0, 2),
                       'dk' . substr($digits, 0, 3), 'dk' . $digits];
            foreach ($layers as $sk) {
                if (!isset($bb[$sk])) {
                    $bb[$sk] = $box;
                } else {
                    if ($box[0] < $bb[$sk][0]) $bb[$sk][0] = $box[0];
                    if ($box[1] < $bb[$sk][1]) $bb[$sk][1] = $box[1];
                    if ($box[2] > $bb[$sk][2]) $bb[$sk][2] = $box[2];
                    if ($box[3] > $bb[$sk][3]) $bb[$sk][3] = $box[3];
                }
            }
        }
    }

    $out = [];
    foreach ($bb as $k => $box) {
        $out[$k] = [
            'key'       => $k,
            'name'      => $k,
            'scope'     => $k,
            'localChat' => '#' . $k,
            'geometry'  => ['type' => 'Point', 'coordinates' => [
                round(($box[0] + $box[2]) / 2, 4),
                round(($box[1] + $box[3]) / 2, 4),
            ]],
        ];
    }
    ksort($out);
    if ($haveApcu) apcu_store($key, $out, 3600);
    return $out;
}

// --- Request --------------------------------------------------------------

$root  = dirname(__DIR__);
$chats = get_chats($root);

// ?all: the entire registry as a list - city chats first (hand-curated), then
// one chat per postal code scope. On a collision (e.g. a curated dk3 and the
// expanded postal code layer dk3) the city chat wins. Each element carries its
// own key.
if (isset($_GET['all'])) {
    $out = [];
    $seen = [];
    foreach ($chats as $k => $v) { $out[] = chat_entry($k, $v); $seen[$k] = true; }
    foreach (get_postal_chats($root) as $entry) {
        if (isset($seen[$entry['key']])) continue;
        $out[] = $entry; // already key-tagged
    }
    echo json_encode(['chats' => $out], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// Otherwise: a single chat. The reference can be given explicitly as
// ?chat=/?id=<name>, or as a bare query key (/api/chats?odense).
$ref = $_GET['chat'] ?? $_GET['id'] ?? null;
if ($ref === null) {
    foreach ($_GET as $k => $v) {
        if ($k === 'all') continue;
        if ($v === '' || $v === null) { $ref = $k; break; }
    }
}
if ($ref === null || $ref === '') {
    fail(400, 'specify ?all or ?chat=<name>.');
}

// Match on key, handle (#...) or name - insensitive to # and case.
$needle = ltrim(strtolower((string)$ref), '#');
foreach ($chats as $k => $v) {
    $cands = [strtolower($k)];
    if (isset($v['localChat'])) $cands[] = ltrim(strtolower((string)$v['localChat']), '#');
    if (isset($v['name']))      $cands[] = strtolower((string)$v['name']);
    if (in_array($needle, $cands, true)) {
        echo json_encode(['chat' => chat_entry($k, $v)], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }
}

// Postal code chat (incl. aggregate layers): "dk50", "#dk5000" (already
// stripped) or just "5000". 1-4 digits, so both dk5 and dk5000 resolve.
$pk = null;
if (preg_match('/^dk\d{1,4}$/', $needle))    $pk = $needle;
elseif (preg_match('/^\d{1,4}$/', $needle))  $pk = 'dk' . $needle;
if ($pk !== null) {
    $postal = get_postal_chats($root);
    if (isset($postal[$pk])) {
        echo json_encode(['chat' => $postal[$pk]], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }
}

fail(404, 'no chat matches "' . $ref . '".');
