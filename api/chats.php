<?php
// chats.php - opslag i by-/chat-registret (cities.json).
//
// GET /api/chats?all           -> alle chats som en liste
// GET /api/chats?chat=<navn>   -> én chat
//
// Chats kommer fra to kilder: de håndkuraterede by-chats i cities.json, OG en
// afledt chat pr. postnummer - hvert postnummer (dk5000, dk5230, …) har sit
// eget chatrum #dk5000 med scope dk5000 og en centroid-Point som placering.
//
// <navn> matcher chattens nøgle ("odense"), dens handle ("#dk-fyn-odense",
// med eller uden #) eller dens navn ("Odense") - ufølsom over for store/små
// bogstaver. Postnummer-chats slås op på "dk5000", "#dk5000" eller bare
// "5000". Den korte form /api/chats?odense virker også.
//
// cities.json og postnummer-filerne er de samme data resten af siden bruger;
// dette endpoint eksponerer dem som API, så en node kan slå en enkelt chat op
// uden at hente og parse hele datasættet.

declare(strict_types=1);

// --- HTTP-rammer ----------------------------------------------------------

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

// --- Data-indlæsning (APCu-cachet, mtime-nøglet - samme mønster som scopes.php) --

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

// Fladt entry -> nøgle-forsynet objekt, så klienten kender chattens id.
function chat_entry(string $key, array $v): array {
    return array_merge(['key' => $key], $v);
}

// Bbox for et Polygon/MultiPolygon som [minx, miny, maxx, maxy], eller null.
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

// Én afledt chat pr. postnummer-scope. Hvert postnummer udfoldes til sine
// prefix-lag efter samme lag-konvention som scopes.php (dk5230 -> dk5, dk52,
// dk523, dk5230), så aggregat-chatrummene (fx dk50, der dækker hele 50xx) også
// kommer med. Hvert postnummers bbox merges ind i alle sine lag, så et
// aggregat-rum får centroid-Point'en for centrummet af ALLE sine postnumre.
// Indlæser postnummer-filerne via manifestet og cacher det afledte resultat i
// APCu, nøglet på filernes mtime - som scopes.php, så et git pull invaliderer
// cachen automatisk.
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

    // Saml (merget) bbox pr. scope-nøgle på tværs af alle prefix-lag.
    $bb = [];
    $seenLeaf = [];
    foreach ($files as $f) {
        $raw = @file_get_contents($root . '/postnumre/' . $f['file']);
        if ($raw === false) continue;
        $d = json_decode($raw, true);
        if (!is_array($d)) continue;
        foreach ($d as $k => $v) {
            if (!preg_match('/^dk(\d{4})$/', $k, $m)) continue;
            if (isset($seenLeaf[$k])) continue;       // første fil vinder (som scopes.php)
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

// --- Anmodning ------------------------------------------------------------

$root  = dirname(__DIR__);
$chats = get_chats($root);

// ?all: hele registret som en liste - by-chats først (håndkuraterede), så én
// chat pr. postnummer-scope. Ved kollision (fx en kurateret dk3 og det
// udfoldede postnummer-lag dk3) vinder by-chatten. Hvert element bærer sin
// egen nøgle.
if (isset($_GET['all'])) {
    $out = [];
    $seen = [];
    foreach ($chats as $k => $v) { $out[] = chat_entry($k, $v); $seen[$k] = true; }
    foreach (get_postal_chats($root) as $entry) {
        if (isset($seen[$entry['key']])) continue;
        $out[] = $entry; // allerede nøgle-forsynet
    }
    echo json_encode(['chats' => $out], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// Ellers: én chat. Referencen kan gives eksplicit som ?chat=/?id=<navn>,
// eller som en bar query-nøgle (/api/chats?odense).
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

// Match på nøgle, handle (#...) eller navn - ufølsom over for # og case.
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

// Postnummer-chat (inkl. aggregat-lag): "dk50", "#dk5000" (allerede strippet)
// eller bare "5000". 1-4 cifre, så både dk5 og dk5000 slår op.
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
