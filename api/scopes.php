<?php
// scopes.php - autoritativ scope-motor for MeshCore-DK-kortet.
//
// GET /api/scopes.php?lat=<bredde>&lon=<længde>
//
// Tager et lat/lon-punkt og returnerer alle scopes for det punkt: de ramte
// polygoner (regioner + postnumre), det udfoldede scope-hierarki, de færdige
// CLI-blokke til repeateren, samt geometrien for de ramte polygoner så
// klienten kan tegne highlightet uden selv at hente polygon-data.
//
// Logikken er en 1:1-port af de rene funktioner i ../script.js. script.js er
// præsentation; DENNE fil er kilden til scope-reglerne. Ændres en regel
// (NEIGHBOR_DIST_M, lag-konventionen, regionDefLines) skal den ændres HER.

declare(strict_types=1);

const M_PER_DEG        = 111320; // meter pr. grad bredde (og længde ved ækvator)
const NEIGHBOR_DIST_M  = 2000;   // et postnummer er nabo hvis grænsen ligger <= dette
const DEF_LIMIT        = 160;    // repeaterens serielle linjegrænse

// --- HTTP-rammer ----------------------------------------------------------

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => $msg], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// --- Geometri-primitiver (port af script.js) ------------------------------

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

// Ray-casting point-in-polygon. Punkt og ringe i [lng, lat].
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
        if (point_in_ring($x, $y, $rings[$i])) return false; // hul
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

// Afstand fra punkt til linjestykke i meter (lokal equirektangulær projektion).
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

// Mindste afstand fra g1's hjørner til g2's kanter; afbryder tidligt <= limit.
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

// --- Scope-udledning ------------------------------------------------------

// De distinkte 2-cifrede prefixer (dkXY) for postnumre der grænser op til key.
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

// Udfolder en hit-nøgle til dens fulde scope-hierarki. For postnummer-nøgler
// (dk####) følges lag-konventionen dk5 -> dk5x -> dk5xx -> dk5230; på dk5x
// indgår eget 2-cifrede prefix PLUS naboernes, sorteret.
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

// Fladt region-træ: * -> eu -> dk -> alle øvrige scopes.
function parent_scope(string $key): string {
    if ($key === 'eu') return '*';
    if ($key === 'dk') return 'eu';
    return 'dk';
}

// Bygger 'region def'-linjer (<= 160 tegn) for en ordnet scope-liste.
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

// --- Data-indlæsning (APCu-cachet, med forudberegnede bboxe) -------------

function get_dataset(string $root): array {
    $regionsPath  = $root . '/regions.json';
    $manifestPath = $root . '/postnumre/index.json';

    $manifestRaw = @file_get_contents($manifestPath);
    $manifest = $manifestRaw !== false ? json_decode($manifestRaw, true) : ['files' => []];
    $files = $manifest['files'] ?? [];

    // Cache-signatur = filsti + mtime for hver kilde, så et git pull (der
    // ændrer mtime) automatisk invaliderer den cachede struktur.
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
    if ($regionsRaw === false) fail(500, 'kunne ikke læse regions.json');
    $regions = json_decode($regionsRaw, true) ?: [];

    $postnumre = [];
    foreach ($files as $f) {
        $raw = @file_get_contents($root . '/postnumre/' . $f['file']);
        if ($raw === false) continue;
        $d = json_decode($raw, true);
        if (!is_array($d)) continue;
        foreach ($d as $k => $v) {
            if (!isset($postnumre[$k])) $postnumre[$k] = $v; // første fil vinder
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

// --- Anmodning ------------------------------------------------------------

$latRaw = $_GET['lat'] ?? null;
$lonRaw = $_GET['lon'] ?? null;
if ($latRaw === null || $lonRaw === null || !is_numeric($latRaw) || !is_numeric($lonRaw)) {
    fail(400, 'lat og lon påkrævet og skal være tal');
}
$lat = (float)$latRaw;
$lon = (float)$lonRaw;
if (!is_finite($lat) || !is_finite($lon) || $lat < -90 || $lat > 90 || $lon < -180 || $lon > 180) {
    fail(400, 'lat/lon uden for gyldigt interval');
}

$data = get_dataset(dirname(__DIR__));
$regions   = $data['regions'];
$postnumre = $data['postnumre'];
$rbb = $data['rbb'];
$pbb = $data['pbb'];

// Hit-test: regioner først, så postnumre (samme rækkefølge som klienten).
// Bbox-forfilter afviser fjerne polygoner med fire sammenligninger før ray-cast.
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

// Udfold hits til det ordnede, unikke scope-hierarki.
$seen = [];
$scopes = [];
foreach ($hits as $k) {
    foreach (scopes_for($k, $postnumre, $pbb) as $s) {
        if (!isset($seen[$s])) { $seen[$s] = true; $scopes[] = $s; }
    }
}

// Geometri for de ramte polygoner, så klienten kan tegne highlightet.
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

// CLI: kun hvis der faktisk er hits (klienten skjuler blokken ved tomt klik).
$cli = null;
if ($scopes) {
    $allScopes = array_merge(['eu', 'dk'], $scopes);
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

header('Cache-Control: public, max-age=3600');

$response = [
    'lat'      => $lat,
    'lon'      => $lon,
    'hits'     => $hits,
    'scopes'   => $scopes,
    'cli'      => $cli,
    'features' => ['type' => 'FeatureCollection', 'features' => $features],
];

echo json_encode($response, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
