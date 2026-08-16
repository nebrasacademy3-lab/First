<?php
declare(strict_types=1);

// Public search endpoint for sick-leave inquiries.
// Secrets are read only from Railway environment variables.
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
date_default_timezone_set('Asia/Riyadh');

define('REQUEST_ID', bin2hex(random_bytes(8)));
define('MAX_REQUEST_BYTES', 4096);
define('RATE_LIMIT_MAX_REQUESTS', 15);
define('RATE_LIMIT_WINDOW_SECONDS', 600);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
header('X-Robots-Tag: noindex, nofollow, noarchive');
header('X-Request-ID: ' . REQUEST_ID);
header_remove('X-Powered-By');
header_remove('Server');

$forwardedProto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
if ((!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || $forwardedProto === 'https') {
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}

function env_value(string $name, ?string $default = null): ?string
{
    $value = getenv($name);
    if ($value === false || trim($value) === '') {
        return $default;
    }
    return trim($value);
}

function env_flag(string $name, bool $default = false): bool
{
    $value = env_value($name);
    if ($value === null) {
        return $default;
    }
    return filter_var($value, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE) ?? $default;
}

function log_search_error(string $message): void
{
    // Railway collects stderr. Never place logs inside the public web directory.
    $cleanMessage = str_replace(["\r", "\n"], ' ', $message);
    error_log('[sickleave-search][' . REQUEST_ID . '] ' . $cleanMessage);
}

function json_response(array $payload, int $httpStatus = 200): never
{
    http_response_code($httpStatus);
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    echo $json === false ? '{"status":"error","msg":"تعذر إنشاء الاستجابة."}' : $json;
    exit;
}

set_exception_handler(function (Throwable $e): void {
    log_search_error('Unhandled exception: ' . $e->getMessage());
    json_response(['status' => 'error', 'msg' => 'حدث خطأ داخلي أثناء تنفيذ الاستعلام. حاول مرة أخرى.'], 500);
});

set_error_handler(function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

function database_config_from_environment(): array
{
    $host = env_value('MYSQLHOST');
    $database = env_value('MYSQLDATABASE');
    $username = env_value('MYSQLUSER');
    $password = env_value('MYSQLPASSWORD');

    if ($host !== null && $database !== null && $username !== null && $password !== null) {
        $port = filter_var(env_value('MYSQLPORT', '3306'), FILTER_VALIDATE_INT, [
            'options' => ['min_range' => 1, 'max_range' => 65535],
        ]);
        if ($port === false) {
            throw new RuntimeException('MYSQLPORT is invalid.');
        }
        return [
            'name' => 'primary',
            'host' => $host,
            'port' => $port,
            'database' => $database,
            'username' => $username,
            'password' => $password,
        ];
    }

    $databaseUrl = env_value('MYSQL_URL') ?? env_value('DATABASE_URL');
    if ($databaseUrl === null) {
        throw new RuntimeException('Railway database environment variables are missing.');
    }

    $parts = parse_url($databaseUrl);
    if ($parts === false || strtolower((string)($parts['scheme'] ?? '')) !== 'mysql') {
        throw new RuntimeException('The database URL must use the mysql scheme.');
    }

    $urlHost = (string)($parts['host'] ?? '');
    $urlDatabase = ltrim((string)($parts['path'] ?? ''), '/');
    $urlUsername = rawurldecode((string)($parts['user'] ?? ''));
    $urlPassword = rawurldecode((string)($parts['pass'] ?? ''));
    $urlPort = (int)($parts['port'] ?? 3306);

    if ($urlHost === '' || $urlDatabase === '' || $urlUsername === '' || $urlPassword === '' || $urlPort < 1 || $urlPort > 65535) {
        throw new RuntimeException('The database URL is incomplete.');
    }

    return [
        'name' => 'primary',
        'host' => $urlHost,
        'port' => $urlPort,
        'database' => $urlDatabase,
        'username' => $urlUsername,
        'password' => $urlPassword,
    ];
}

function connect_database(array $config): ?PDO
{
    try {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $config['host'],
            $config['port'],
            $config['database']
        );
        $pdo = new PDO($dsn, $config['username'], $config['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
        $pdo->exec("SET SESSION time_zone = '+03:00'");
        return $pdo;
    } catch (Throwable $e) {
        log_search_error('Connection failed for ' . ($config['name'] ?? 'database') . ': ' . $e->getMessage());
        return null;
    }
}

function request_origin_is_allowed(): bool
{
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($origin === '') {
        return true;
    }

    $configuredOrigins = env_value('ALLOWED_ORIGINS');
    if ($configuredOrigins !== null) {
        $allowed = array_filter(array_map(
            static fn(string $item): string => rtrim(trim($item), '/'),
            explode(',', $configuredOrigins)
        ));
        return in_array(rtrim($origin, '/'), $allowed, true);
    }

    $originParts = parse_url($origin);
    if ($originParts === false || empty($originParts['host'])) {
        return false;
    }

    $forwardedHost = trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_HOST'] ?? ''))[0]);
    $requestHost = strtolower(preg_replace('/:\d+$/', '', $forwardedHost !== '' ? $forwardedHost : (string)($_SERVER['HTTP_HOST'] ?? '')) ?? '');
    return $requestHost !== '' && hash_equals($requestHost, strtolower((string)$originParts['host']));
}

function client_ip(): string
{
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    $onRailway = env_value('RAILWAY_ENVIRONMENT') !== null || env_value('RAILWAY_ENVIRONMENT_NAME') !== null;

    if ($onRailway || env_flag('TRUST_PROXY', false)) {
        $forwarded = trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))[0]);
        if (filter_var($forwarded, FILTER_VALIDATE_IP)) {
            $ip = $forwarded;
        }
    }

    return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '0.0.0.0';
}

function enforce_rate_limit(): void
{
    $key = hash('sha256', client_ip() . '|' . (env_value('RATE_LIMIT_SALT', 'sickleave-public') ?? 'sickleave-public'));
    $path = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'sickleave-rate-' . $key . '.json';
    $handle = @fopen($path, 'c+');
    if ($handle === false) {
        log_search_error('Unable to open the rate-limit store.');
        return;
    }

    try {
        if (!flock($handle, LOCK_EX)) {
            log_search_error('Unable to lock the rate-limit store.');
            return;
        }

        $raw = stream_get_contents($handle);
        $decoded = $raw !== false && $raw !== '' ? json_decode($raw, true) : [];
        $timestamps = is_array($decoded) ? $decoded : [];
        $now = time();
        $minimum = $now - RATE_LIMIT_WINDOW_SECONDS;
        $timestamps = array_values(array_filter(
            $timestamps,
            static fn(mixed $timestamp): bool => is_int($timestamp) && $timestamp > $minimum
        ));

        if (count($timestamps) >= RATE_LIMIT_MAX_REQUESTS) {
            $retryAfter = max(1, RATE_LIMIT_WINDOW_SECONDS - ($now - (int)$timestamps[0]));
            header('Retry-After: ' . $retryAfter);
            json_response(['status' => 'error', 'msg' => 'طلبات كثيرة، حاول مرة أخرى بعد قليل.'], 429);
        }

        $timestamps[] = $now;
        rewind($handle);
        ftruncate($handle, 0);
        fwrite($handle, json_encode($timestamps, JSON_THROW_ON_ERROR));
        fflush($handle);
        flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

function request_data(): array
{
    $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? 'application/x-www-form-urlencoded'))[0]));
    if ($contentType === 'application/json') {
        $raw = file_get_contents('php://input');
        $decoded = json_decode($raw === false ? '' : $raw, true);
        return is_array($decoded) ? $decoded : [];
    }
    if ($contentType !== 'application/x-www-form-urlencoded' && $contentType !== 'multipart/form-data') {
        json_response(['status' => 'error', 'msg' => 'نوع الطلب غير مدعوم.'], 415);
    }
    return $_POST;
}

function normalize_request_value(array $data, string $key, string $fallbackKey = ''): string
{
    $value = $data[$key] ?? null;
    if (($value === null || $value === '') && $fallbackKey !== '') {
        $value = $data[$fallbackKey] ?? '';
    }
    return is_scalar($value) ? trim((string)$value) : '';
}

function normalize_lookup_value(string $value, bool $uppercase = false): string
{
    $value = trim($value);
    // Remove normal and invisible separators that users commonly copy with service codes/IDs.
    $value = preg_replace('/[\s\x{200B}-\x{200D}\x{FEFF}]+/u', '', $value) ?? $value;
    return $uppercase ? strtoupper($value) : $value;
}

function compact_lookup_sql(string $expression): string
{
    // Keep this compatible with older MySQL versions by avoiding REGEXP_REPLACE.
    return "UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM({$expression}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), '-', ''))";
}

function h(?string $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function mask_identity(string $identity): string
{
    $length = strlen($identity);
    if ($length <= 4) {
        return str_repeat('*', $length);
    }
    return str_repeat('*', $length - 4) . substr($identity, -4);
}

function first_non_empty(array $row, array $keys): string
{
    foreach ($keys as $key) {
        if (isset($row[$key]) && trim((string)$row[$key]) !== '') {
            return (string)$row[$key];
        }
    }
    return '';
}

function format_date(?string $date): string
{
    if (!$date) {
        return '';
    }
    $dt = DateTime::createFromFormat('Y-m-d', substr($date, 0, 10));
    return $dt ? $dt->format('Y-m-d') : $date;
}


function table_columns(PDO $pdo, string $table): array
{
    static $cache = [];
    $key = spl_object_id($pdo) . ':' . $table;
    if (isset($cache[$key])) {
        return $cache[$key];
    }

    try {
        $stmt = $pdo->prepare('SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = :table_name');
        $stmt->execute([':table_name' => $table]);
        $cache[$key] = array_fill_keys($stmt->fetchAll(PDO::FETCH_COLUMN), true);
    } catch (Throwable $e) {
        log_search_error('Unable to inspect columns for ' . $table . ': ' . $e->getMessage());
        $cache[$key] = [];
    }

    return $cache[$key];
}

function has_column(PDO $pdo, string $table, string $column): bool
{
    $columns = table_columns($pdo, $table);
    return isset($columns[$column]);
}

function coalesce_columns(PDO $pdo, string $table, string $alias, array $columns, string $fallback = "''"): string
{
    $parts = [];
    foreach ($columns as $column) {
        if (has_column($pdo, $table, $column)) {
            $parts[] = "NULLIF({$alias}.{$column}, '')";
        }
    }

    if (!$parts) {
        return $fallback;
    }

    $parts[] = $fallback;
    return 'COALESCE(' . implode(', ', $parts) . ')';
}

function search_leave(PDO $pdo, string $code, string $identity, bool $active): ?array
{
    // This query adapts to the schema created by admin.php while keeping
    // compatibility with older databases that still have legacy columns.
    $patientNameExpr = coalesce_columns($pdo, 'patients', 'p', ['name_ar', 'name', 'name_en'], "''");
    $doctorNameParts = [];
    foreach (['name_ar', 'name', 'name_en'] as $column) {
        if (has_column($pdo, 'doctors', $column)) {
            $doctorNameParts[] = "NULLIF(d.{$column}, '')";
        }
    }
    if (has_column($pdo, 'sick_leaves', 'doctor_name_en')) {
        $doctorNameParts[] = "NULLIF(sl.doctor_name_en, '')";
    }
    $doctorNameExpr = $doctorNameParts ? 'COALESCE(' . implode(', ', array_merge($doctorNameParts, ["''"])) . ')' : "''";

    $doctorTitleParts = [];
    foreach (['title_ar', 'title', 'title_en'] as $column) {
        if (has_column($pdo, 'doctors', $column)) {
            $doctorTitleParts[] = "NULLIF(d.{$column}, '')";
        }
    }
    if (has_column($pdo, 'sick_leaves', 'doctor_title_en')) {
        $doctorTitleParts[] = "NULLIF(sl.doctor_title_en, '')";
    }
    $doctorTitleExpr = $doctorTitleParts ? 'COALESCE(' . implode(', ', array_merge($doctorTitleParts, ["''"])) . ')' : "''";

    $companionNameExpr = has_column($pdo, 'sick_leaves', 'companion_name') ? 'sl.companion_name' : "''";
    $companionRelationExpr = has_column($pdo, 'sick_leaves', 'companion_relation') ? 'sl.companion_relation' : "''";
    $isCompanionExpr = has_column($pdo, 'sick_leaves', 'is_companion') ? 'sl.is_companion' : '0';

    $serviceCodeCompactExpr = compact_lookup_sql('sl.service_code');
    $identityCompactExpr = compact_lookup_sql('p.identity_number');

    if (has_column($pdo, 'sick_leaves', 'deleted_at')) {
        $activeCondition = 'sl.deleted_at IS ' . ($active ? 'NULL' : 'NOT NULL');
    } elseif (has_column($pdo, 'sick_leaves', 'is_deleted')) {
        $activeCondition = 'sl.is_deleted = ' . ($active ? '0' : '1');
    } else {
        $activeCondition = $active ? '1 = 1' : '1 = 0';
    }

    $sql = "
        SELECT
            sl.id AS leave_id,
            sl.service_code,
            p.identity_number,
            {$patientNameExpr} AS patient_name,
            sl.issue_date,
            sl.start_date,
            sl.end_date,
            sl.days_count,
            {$doctorNameExpr} AS doctor_name,
            {$doctorTitleExpr} AS doctor_title,
            {$isCompanionExpr} AS is_companion,
            {$companionNameExpr} AS companion_name,
            {$companionRelationExpr} AS companion_relation
        FROM sick_leaves sl
        INNER JOIN patients p ON p.id = sl.patient_id
        LEFT JOIN doctors d ON d.id = sl.doctor_id
        WHERE (UPPER(TRIM(sl.service_code)) = UPPER(:service_code)
               OR {$serviceCodeCompactExpr} = :service_code_compact)
          AND (TRIM(p.identity_number) = :identity_number
               OR {$identityCompactExpr} = :identity_number_compact)
          AND {$activeCondition}
        ORDER BY sl.id DESC
        LIMIT 1
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        ':service_code' => $code,
        ':service_code_compact' => normalize_lookup_value(str_replace('-', '', $code), true),
        ':identity_number' => $identity,
        ':identity_number_compact' => normalize_lookup_value(str_replace('-', '', $identity), true),
    ]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function log_leave_query(PDO $pdo, int $leaveId, string $source = 'external'): void
{
    if (!env_flag('LOG_INQUIRIES', true)) {
        return;
    }

    try {
        $stmt = $pdo->prepare('INSERT INTO leave_queries (leave_id, queried_at, source) VALUES (:leave_id, NOW(), :source)');
        $stmt->execute([
            ':leave_id' => $leaveId,
            ':source' => $source,
        ]);
    } catch (Throwable $e) {
        log_search_error('Unable to log leave query for leave #' . $leaveId . ': ' . $e->getMessage());
    }
}

function render_leave_result(array $row): string
{
    $serviceCode = h($row['service_code'] ?? '');
    $identityNumber = h(mask_identity((string)($row['identity_number'] ?? '')));
    $patientName = h(first_non_empty($row, ['patient_name']));
    $issueDate = h(format_date($row['issue_date'] ?? ''));
    $startDate = h(format_date($row['start_date'] ?? ''));
    $endDate = h(format_date($row['end_date'] ?? ''));
    $daysCount = h((string)($row['days_count'] ?? ''));
    $doctorName = h(first_non_empty($row, ['doctor_name']));
    $doctorTitle = h(first_non_empty($row, ['doctor_title']));

    $companionBlock = '';
    if (!empty($row['is_companion']) && trim((string)($row['companion_name'] ?? '')) !== '') {
        $companionName = h($row['companion_name'] ?? '');
        $companionRelation = h($row['companion_relation'] ?? '');
        $companionBlock = <<<HTML
          <div class="col-md-6"><span>اسم المرافق: </span>{$companionName}</div>
          <div class="col-md-6"><span>صلة القرابة: </span>{$companionRelation}</div>
HTML;
    }

    return <<<HTML
    <div class="row justify-content-center mt-1">
      <div class="col-md-5 p-4">
        <div class="form-group mb-3" style="padding-bottom: 10px;">
          <input type="text" maxlength="20" placeholder="رمز الخدمة" class="form-control" value="{$serviceCode}" readonly>
        </div>
        <div class="form-group mb-3">
          <input type="text" maxlength="10" pattern="\d*" placeholder="رقم الهوية / الإقامة" class="form-control" value="{$identityNumber}" readonly>
        </div>
        <div class="results-inquiery row">
          <div class="col-md-6"><span>الاسم: </span>{$patientName}</div>
          {$companionBlock}
          <div class="col-md-6"><span>تاريخ إصدار تقرير الإجازة:</span> {$issueDate}</div>
          <div class="col-md-6"><span>تبدأ من:</span> {$startDate}</div>
          <div class="col-md-6"><span>وحتى:</span> {$endDate}</div>
          <div class="col-md-6"><span>المدة بالأيام:</span> {$daysCount}</div>
          <div class="col-md-6"><span>اسم الطبيب:</span> {$doctorName}</div>
          <div class="col-md-6"><span>المسمى الوظيفي:</span> {$doctorTitle}</div>
        </div>
        <a href="/sickleave/index.html" class="btn btn-primary mt-3">استعلام جديد</a>
      </div>
    </div>
HTML;
}

$requestMethod = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($requestMethod !== 'POST') {
    header('Allow: POST');
    json_response(['status' => 'error', 'msg' => 'طريقة الطلب غير مسموحة.'], 405);
}

$contentLength = filter_var($_SERVER['CONTENT_LENGTH'] ?? 0, FILTER_VALIDATE_INT);
if ($contentLength !== false && $contentLength > MAX_REQUEST_BYTES) {
    json_response(['status' => 'error', 'msg' => 'حجم الطلب أكبر من المسموح.'], 413);
}

if (!request_origin_is_allowed()) {
    json_response(['status' => 'error', 'msg' => 'مصدر الطلب غير مسموح.'], 403);
}

enforce_rate_limit();
$requestData = request_data();
$code = normalize_lookup_value(normalize_request_value($requestData, 'code', 'service_code'), true);
$identity = normalize_lookup_value(normalize_request_value($requestData, 'id', 'identity_number'), false);

if ($code === '') {
    json_response(['status' => 'error', 'msg' => 'فضلاً اكتب رمز الخدمة'], 422);
}
if ($identity === '') {
    json_response(['status' => 'error', 'msg' => 'فضلاً اكتب رقم الهوية'], 422);
}
if (!preg_match('/^(?=.*[A-Z])(?=.*\d)[A-Z0-9-]{6,20}$/', $code)) {
    json_response(['status' => 'error', 'msg' => 'رمز الخدمة غير صالح'], 422);
}
if (!preg_match('/^\d{10}$/', $identity)) {
    json_response(['status' => 'error', 'msg' => 'رقم الهوية غير صالح'], 422);
}

try {
    $databaseConfig = database_config_from_environment();
} catch (Throwable $e) {
    log_search_error('Database configuration failed: ' . $e->getMessage());
    json_response(['status' => 'error', 'msg' => 'إعدادات الاتصال بالخادم غير مكتملة.'], 503);
}

$pdo = connect_database($databaseConfig);
if (!$pdo) {
    json_response(['status' => 'error', 'msg' => 'تعذّر الاتصال بالخادم حالياً. حاول مرة أخرى لاحقاً.'], 503);
}

try {
    $activeLeave = search_leave($pdo, $code, $identity, true);
    if ($activeLeave) {
        log_leave_query($pdo, (int)$activeLeave['leave_id']);
        json_response(['status' => 'ok', 'html' => render_leave_result($activeLeave)]);
    }

    $archivedLeave = search_leave($pdo, $code, $identity, false);
    if ($archivedLeave) {
        log_leave_query($pdo, (int)$archivedLeave['leave_id']);
    }
} catch (Throwable $e) {
    log_search_error('Search failed: ' . $e->getMessage());
    json_response(['status' => 'error', 'msg' => 'تعذّر تنفيذ الاستعلام حالياً. حاول مرة أخرى لاحقاً.'], 503);
}

// Make high-volume guessing less efficient without exposing whether one field matched.
usleep(random_int(120000, 260000));
json_response(['status' => 'notfound']);