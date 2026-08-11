<?php
// scopes.php - authoritative scope engine for the MeshCore-DK map.
//
// GET /api/scopes.php?lat=<latitude>&lon=<longitude>
//
// Takes a lat/lon point and returns all scopes for that point: the hit
// polygons (regions + postal codes), the expanded scope hierarchy, the
// finished CLI blocks for the repeater, plus the geometry of the hit polygons
// so the client can draw the highlight without fetching polygon data itself.
//
// The logic is a 1:1 port of the pure functions in ../script.js. script.js is
// presentation; THIS file is the source of the scope rules. If a rule changes
// (NEIGHBOR_DIST_M, the layer convention, regionDefLines) it must change HERE.

declare(strict_types=1);

const M_PER_DEG        = 111320; // meters per degree latitude (and longitude at the equator)
const NEIGHBOR_DIST_M  = 2000;   // a postal code is a neighbor if the border lies <= this
const DEF_LIMIT        = 160;    // the repeater's serial line limit

// The fixed top-level scopes that are not derived from geometry, with their
// parent in the scope tree: * -> {eu, europe} -> dk -> everything else. 'eu'
// and 'europe' are both in use and redundant (like #dk/#danmark), but both must
// exist. This is the only source of the fixed scopes - both ?all and the CLI
// blocks read from here.
const FIXED_SCOPE_PARENTS = [
    'eu'     => '*',
    'europe' => '*',
    'dk'     => 'eu',
];

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

// --- Geometry primitives (port of script.js) ------------------------------

function rings_of(?array $geom): array {
    if (!$geom) return [];
    if (($geom['type'] ?? '') === 'Polygon') return $geom['coordinates'];
    if (($geom['type'] ?? '') === 'MultiPolygon') {
        $out = [];
        foreach ($geom['coordinates'] as $poly) {
            foreach ($poly as $ring) $out[] = $ring;
        }
        return $out;
    }
    return [];
}

function geom_bbox(?array $geom): array {
    $minx = INF; $miny = INF; $maxx = -INF; $maxy = -INF;
    foreach (rings_of($geom) as $ring) {
        foreach ($ring as $pt) {
            $x = $pt[0]; $y = $pt[1];
            if ($x < $minx) $minx = $x;
            if ($x > $maxx) $maxx = $x;
            if ($y < $miny) $miny = $y;
            if ($y > $maxy) $maxy = $y;
        }
    }
    return [$minx, $miny, $maxx, $maxy];
}

// Ray-casting point-in-polygon. Point and rings in [lng, lat].
function point_in_ring(float $x, float $y, array $ring): bool {
    $inside = false;
    $n = count($ring);
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        $xi = $ring[$i][0]; $yi = $ring[$i][1];
        $xj = $ring[$j][0]; $yj = $ring[$j][1];
        $intersect = (($yi > $y) !== ($yj > $y)) &&
            ($x < ($xj - $xi) * ($y - $yi) / ($yj - $yi) + $xi);
        if ($intersect) $inside = !$inside;
    }
    return $inside;
}

function point_in_polygon(float $x, float $y, array $rings): bool {
    if (!$rings) return false;
    if (!point_in_ring($x, $y, $rings[0])) return false;
    for ($i = 1; $i < count($rings); $i++) {
        if (point_in_ring($x, $y, $rings[$i])) return false; // hole
    }
    return true;
}

function point_in_geom(float $x, float $y, ?array $geom): bool {
    if (!$geom) return false;
    if (($geom['type'] ?? '') === 'Polygon') return point_in_polygon($x, $y, $geom['coordinates']);
    if (($geom['type'] ?? '') === 'MultiPolygon') {
        foreach ($geom['coordinates'] as $poly) {
            if (point_in_polygon($x, $y, $poly)) return true;
        }
        return false;
    }
    return false;
}

// Distance from point to line segment in meters (local equirectangular projection).
function seg_dist_m(array $p, array $a, array $b, float $sx, float $sy): float {
    $px = $p[0] * $sx; $py = $p[1] * $sy;
    $ax = $a[0] * $sx; $ay = $a[1] * $sy;
    $bx = $b[0] * $sx; $by = $b[1] * $sy;
    $dx = $bx - $ax; $dy = $by - $ay;
    $len = $dx * $dx + $dy * $dy;
    $t = $len ? (($px - $ax) * $dx + ($py - $ay) * $dy) / $len : 0.0;
    $t = $t < 0 ? 0.0 : ($t > 1 ? 1.0 : $t);
    return hypot($px - ($ax + $t * $dx), $py - ($ay + $t * $dy));
}

// Smallest distance from g1's corners to g2's edges; short-circuits <= limit.
function boundary_dist_m(?array $g1, ?array $g2, float $sx, float $sy, float $limit): float {
    $best = INF;
    $r2 = rings_of($g2);
    foreach (rings_of($g1) as $ring) {
        foreach ($ring as $p) {
            foreach ($r2 as $ring2) {
                $m = count($ring2);
                for ($i = 0; $i < $m - 1; $i++) {
                    $d = seg_dist_m($p, $ring2[$i], $ring2[$i + 1], $sx, $sy);
                    if ($d < $best) {
                        $best = $d;
                        if ($best <= $limit) return $best;
                    }
                }
            }
        }
    }
    return $best;
}

// --- Scope derivation ------------------------------------------------------

// The distinct 2-digit prefixes (dkXY) for postal codes bordering key.
function neighbor_prefixes_for(string $key, array $postnumre, array $pbb): array {
    static $cache = [];
    if (isset($cache[$key])) return $cache[$key];

    $self = $postnumre[$key] ?? null;
    if (!$self || !isset($self['geometry'])) return $cache[$key] = [];

    $bb = $pbb[$key] ?? geom_bbox($self['geometry']);
    $refLat = ($bb[1] + $bb[3]) / 2;
    $sx = M_PER_DEG * cos(deg2rad($refLat));
    $sy = M_PER_DEG;
    $padLon = NEIGHBOR_DIST_M / $sx;
    $padLat = NEIGHBOR_DIST_M / $sy;

    $seen = [];
    foreach ($postnumre as $k => $e) {
        if ($k === $key) continue;
        if (!preg_match('/^dk(\d{4})$/', $k, $mm)) continue;
        if (!isset($e['geometry'])) continue;
        $ob = $pbb[$k] ?? geom_bbox($e['geometry']);
        if ($ob[0] > $bb[2] + $padLon || $ob[2] < $bb[0] - $padLon ||
            $ob[1] > $bb[3] + $padLat || $ob[3] < $bb[1] - $padLat) continue;
        $d = min(
            boundary_dist_m($self['geometry'], $e['geometry'], $sx, $sy, NEIGHBOR_DIST_M),
            boundary_dist_m($e['geometry'], $self['geometry'], $sx, $sy, NEIGHBOR_DIST_M)
        );
        if ($d <= NEIGHBOR_DIST_M) $seen['dk' . substr($mm[1], 0, 2)] = true;
    }
    $res = array_keys($seen);
    sort($res);
    return $cache[$key] = $res;
}

// Expands a hit key into its full scope hierarchy. For postal code keys
// (dk####) the layer convention dk5 -> dk5x -> dk5xx -> dk5230 is followed; at
// dk5x the own 2-digit prefix PLUS the neighbors' are included, sorted.
function scopes_for(string $key, array $postnumre, array $pbb): array {
    if (!preg_match('/^dk(\d{4})$/', $key, $m)) return [$key];
    $d = $m[1];
    $layer2 = array_values(array_unique(array_merge(
        ['dk' . substr($d, 0, 2)],
        neighbor_prefixes_for($key, $postnumre, $pbb)
    )));
    sort($layer2);
    return array_merge(['dk' . $d[0]], $layer2, ['dk' . substr($d, 0, 3)], ['dk' . $d]);
}

// The entire scope universe for ?all: the fixed top-level scopes (eu, europe,
// dk) plus every region key plus every postal code expanded to its prefix
// layers (dk5230 -> dk5, dk52, dk523, dk5230), flattened into one deduplicated,
// sorted list. Neighbor derivation is NOT included - it is point-specific and
// makes no sense for the whole dataset; but because a postal code like 5000
// exists, its 2-digit prefix dk50 shows up on its own.
function all_scopes(array $regions, array $postnumre): array {
    $seen = [];
    foreach (array_keys(FIXED_SCOPE_PARENTS) as $k) $seen[$k] = true;
    foreach ($regions as $k => $_) $seen[$k] = true;
    foreach ($postnumre as $k => $_) {
        if (!preg_match('/^dk(\d{4})$/', $k, $m)) { $seen[$k] = true; continue; }
        $d = $m[1];
        $seen['dk' . $d[0]]           = true;
        $seen['dk' . substr($d, 0, 2)] = true;
        $seen['dk' . substr($d, 0, 3)] = true;
        $seen['dk' . $d]              = true;
    }
    $res = array_keys($seen);
    sort($res);
    return $res;
}

// Flat region tree: * -> {eu, europe} -> dk -> all other scopes.
function parent_scope(string $key): string {
    return FIXED_SCOPE_PARENTS[$key] ?? 'dk';
}

// Builds 'region def' lines (<= 160 chars) for an ordered scope list.
function region_def_lines(array $scopes): array {
    $prefix = 'region def ';
    $lines = [];
    $i = 0;
    $n = count($scopes);
    $lead = null;
    while ($i < $n) {
        $parts = $lead !== null ? [$lead] : [];
        $minParts = count($parts);
        while ($i < $n) {
            $node = $scopes[$i];
            $jump = null;
            if ($i < $n - 1) {
                $np = parent_scope($scopes[$i + 1]);
                if ($np !== $node) $jump = $np;
            }
            $token = $jump !== null ? $node . '|' . $jump : $node;
            $candidate = array_merge($parts, [$token]);
            if (strlen($prefix . implode(' ', $candidate)) > DEF_LIMIT && count($parts) > $minParts) break;
            $parts[] = $token;
            $i++;
        }
        $lines[] = $prefix . implode(' ', $parts);
        $lead = $i < $n ? 'eu|' . parent_scope($scopes[$i]) : null;
    }
    return $lines;
}

// --- Data loading (APCu-cached, with precomputed bboxes) -----------------

function get_dataset(string $root): array {
    $regionsPath  = $root . '/regions.json';
    $manifestPath = $root . '/postnumre/index.json';

    $manifestRaw = @file_get_contents($manifestPath);
    $manifest = $manifestRaw !== false ? json_decode($manifestRaw, true) : ['files' => []];
    $files = $manifest['files'] ?? [];

    // Cache signature = file path + mtime for each source, so a git pull (which
    // changes mtime) automatically invalidates the cached structure.
    $paths = [$regionsPath, $manifestPath];
    foreach ($files as $f) $paths[] = $root . '/postnumre/' . $f['file'];
    $sig = '';
    foreach ($paths as $p) $sig .= $p . ':' . (@filemtime($p) ?: 0) . ';';
    $key = 'mcdk:dataset:' . md5($sig);

    $haveApcu = function_exists('apcu_fetch');
    if ($haveApcu) {
        $cached = apcu_fetch($key, $ok);
        if ($ok) return $cached;
    }

    $regionsRaw = @file_get_contents($regionsPath);
    if ($regionsRaw === false) fail(500, 'could not read regions.json');
    $regions = json_decode($regionsRaw, true) ?: [];

    $postnumre = [];
    foreach ($files as $f) {
        $raw = @file_get_contents($root . '/postnumre/' . $f['file']);
        if ($raw === false) continue;
        $d = json_decode($raw, true);
        if (!is_array($d)) continue;
        foreach ($d as $k => $v) {
            if (!isset($postnumre[$k])) $postnumre[$k] = $v; // first file wins
        }
    }

    $rbb = [];
    foreach ($regions as $k => $v) {
        if (isset($v['geometry'])) $rbb[$k] = geom_bbox($v['geometry']);
    }
    $pbb = [];
    foreach ($postnumre as $k => $v) {
        if (isset($v['geometry'])) $pbb[$k] = geom_bbox($v['geometry']);
    }

    $dataset = compact('regions', 'postnumre', 'rbb', 'pbb');
    if ($haveApcu) apcu_store($key, $dataset, 3600);
    return $dataset;
}

// --- Request --------------------------------------------------------------

$root = dirname(__DIR__);

// ?all: the entire scope universe instead of scopes for a single point.
if (isset($_GET['all'])) {
    $data = get_dataset($root);
    $scopes = all_scopes($data['regions'], $data['postnumre']);
    echo json_encode(
        ['scopes' => $scopes, 'count' => count($scopes)],
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );
    exit;
}

$latRaw = $_GET['lat'] ?? null;
$lonRaw = $_GET['lon'] ?? null;
if ($latRaw === null || $lonRaw === null || !is_numeric($latRaw) || !is_numeric($lonRaw)) {
    fail(400, 'lat/lon not supplied or incorrectly supplied.');
}
$lat = (float)$latRaw;
$lon = (float)$lonRaw;
if (!is_finite($lat) || !is_finite($lon) || $lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) {
    fail(400, 'lat/lon outside valid range.');
}

$data = get_dataset($root);
$regions   = $data['regions'];
$postnumre = $data['postnumre'];
$rbb = $data['rbb'];
$pbb = $data['pbb'];

// Hit test: regions first, then postal codes (same order as the client).
// Bbox pre-filter rejects distant polygons with four comparisons before ray-cast.
$hits = [];
foreach ($regions as $k => $v) {
    $bb = $rbb[$k] ?? null;
    if (!$bb || $lon < $bb[0] || $lon > $bb[2] || $lat < $bb[1] || $lat > $bb[3]) continue;
    if (point_in_geom($lon, $lat, $v['geometry'] ?? null)) $hits[] = $k;
}
foreach ($postnumre as $k => $v) {
    $bb = $pbb[$k] ?? null;
    if (!$bb || $lon < $bb[0] || $lon > $bb[2] || $lat < $bb[1] || $lat > $bb[3]) continue;
    if (point_in_geom($lon, $lat, $v['geometry'] ?? null)) $hits[] = $k;
}

// Expand hits into the ordered, unique scope hierarchy.
$seen = [];
$scopes = [];
foreach ($hits as $k) {
    foreach (scopes_for($k, $postnumre, $pbb) as $s) {
        if (!isset($seen[$s])) { $seen[$s] = true; $scopes[] = $s; }
    }
}

// Geometry for the hit polygons, so the client can draw the highlight.
$features = [];
foreach ($hits as $k) {
    $entry = $regions[$k] ?? $postnumre[$k] ?? null;
    if ($entry && isset($entry['geometry'])) {
        $features[] = [
            'type' => 'Feature',
            'properties' => ['region' => $k],
            'geometry' => $entry['geometry'],
        ];
    }
}

// CLI: only if there actually are hits (the client hides the block on an empty click).
$cli = null;
if ($scopes) {
    $allScopes = array_merge(array_keys(FIXED_SCOPE_PARENTS), $scopes);
    $oldCli = implode("\n", array_map(
        fn($s) => "region put $s\nregion allowf $s",
        $allScopes
    )) . "\nregion save";
    $newCli = implode("\n", region_def_lines($allScopes)) . "\nregion save";
    $cli = [
        'firmware_1_16_0_plus'      => $newCli,
        'firmware_1_12_0_to_1_15_0' => $oldCli,
    ];
}

$response = [
    'lat'      => $lat,
    'lon'      => $lon,
    'hits'     => $hits,
    'scopes'   => $scopes,
    'cli'      => $cli,
    'features' => ['type' => 'FeatureCollection', 'features' => $features],
];

echo json_encode($response, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
