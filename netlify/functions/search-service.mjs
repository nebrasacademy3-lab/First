import mysql from "mysql2/promise";
import { randomBytes, randomInt } from "node:crypto";

const MAX_REQUEST_BYTES = 4096;
const tableColumnCache = new Map();

function envValue(name, fallback = null) {
  const value = process.env[name];
  if (value == null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function envFlag(name, fallback = false) {
  const value = envValue(name);
  if (value == null) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function requestId() {
  return randomBytes(8).toString("hex");
}

function securityHeaders(id) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-request-id": id,
  };
}

function jsonResponse(payload, status, id, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...securityHeaders(id), ...extraHeaders },
  });
}

function logError(id, message) {
  const clean = String(message).replace(/[\r\n]+/g, " ");
  console.error(`[sickleave-search][${id}] ${clean}`);
}

function parseDatabaseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "mysql:") throw new Error(`${name} must use the mysql scheme.`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const host = url.hostname;
  const port = Number(url.port || 3306);
  const user = decodeURIComponent(url.username || "");
  const password = decodeURIComponent(url.password || "");
  if (!host || !database || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} is incomplete.`);
  }
  return { host, port, user, password, database };
}

function isRailwayPrivateHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value.endsWith(".railway.internal") || value === "railway.internal";
}

function databaseConfigFromEnvironment() {
  // Netlify runs OUTSIDE Railway's private network. Always prefer a public TCP-proxy URL.
  // Accept both names currently encountered in Railway projects and a project-specific alias.
  const publicCandidates = [
    ["MYSQL_PUBLIC_URL", envValue("MYSQL_PUBLIC_URL")],
    ["DATABASE_PUBLIC_URL", envValue("DATABASE_PUBLIC_URL")],
    ["SEARCH_DB_URL", envValue("SEARCH_DB_URL")],
  ];
  for (const [name, value] of publicCandidates) {
    if (value) return parseDatabaseUrl(value, name);
  }

  // Also accept a full DATABASE_URL/MYSQL_URL when it already points at a public proxy.
  const urlCandidates = [
    ["MYSQL_URL", envValue("MYSQL_URL")],
    ["DATABASE_URL", envValue("DATABASE_URL")],
  ];
  for (const [name, value] of urlCandidates) {
    if (!value) continue;
    const parsed = parseDatabaseUrl(value, name);
    if (!isRailwayPrivateHost(parsed.host)) return parsed;
  }

  // Explicit public split variables, useful when the public URL was decomposed manually.
  const publicHost = envValue("MYSQL_PUBLIC_HOST") || envValue("RAILWAY_TCP_PROXY_DOMAIN");
  const publicPortRaw = envValue("MYSQL_PUBLIC_PORT") || envValue("RAILWAY_TCP_PROXY_PORT");
  const database = envValue("MYSQLDATABASE") || envValue("MYSQL_DATABASE") || envValue("MYSQL_PUBLIC_DATABASE");
  const user = envValue("MYSQLUSER") || envValue("MYSQL_USER") || envValue("MYSQL_PUBLIC_USER");
  const password = envValue("MYSQLPASSWORD") || envValue("MYSQL_PASSWORD") || envValue("MYSQL_PUBLIC_PASSWORD");
  if (publicHost && publicPortRaw && database && user && password) {
    const port = Number(publicPortRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Public MySQL port is invalid.");
    return { host: publicHost, port, user, password, database };
  }

  // Last resort: split MYSQL* variables are accepted only when their host is actually public.
  const host = envValue("MYSQLHOST") || envValue("MYSQL_HOST");
  const rawPort = envValue("MYSQLPORT") || envValue("MYSQL_PORT") || "3306";
  const port = Number(rawPort);
  if (host && database && user && password) {
    if (isRailwayPrivateHost(host)) {
      throw new Error("Railway private MySQL hostname cannot be reached from Netlify; use MYSQL_PUBLIC_URL/TCP Proxy.");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MYSQL port is invalid.");
    return { host, port, user, password, database };
  }

  throw new Error("Database environment variables are missing. Expected MYSQL_PUBLIC_URL (preferred).");
}

async function connectDatabase(config) {
  const options = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
    connectTimeout: 5000,
    dateStrings: true,
    timezone: "+03:00",
  };
  if (envFlag("MYSQL_SSL", false)) options.ssl = {};
  const connection = await mysql.createConnection(options);
  await connection.query("SET SESSION time_zone = '+03:00'");
  return connection;
}

function requestOriginIsAllowed(request) {
  const origin = (request.headers.get("origin") || "").trim();
  if (!origin) return true;

  const configured = envValue("ALLOWED_ORIGINS");
  if (configured) {
    const allowed = configured
      .split(",")
      .map((item) => item.trim().replace(/\/$/, ""))
      .filter(Boolean);
    return allowed.includes(origin.replace(/\/$/, ""));
  }

  try {
    return new URL(origin).host.toLowerCase() === new URL(request.url).host.toLowerCase();
  } catch {
    return false;
  }
}

async function requestData(request, id) {
  const contentType = (request.headers.get("content-type") || "application/x-www-form-urlencoded")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return { error: jsonResponse({ status: "error", msg: "حجم الطلب أكبر من المسموح." }, 413, id) };
  }

  const clone = request.clone();
  const bytes = new Uint8Array(await clone.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    return { error: jsonResponse({ status: "error", msg: "حجم الطلب أكبر من المسموح." }, 413, id) };
  }

  if (contentType === "application/json") {
    try {
      const value = await request.json();
      return { data: value && typeof value === "object" && !Array.isArray(value) ? value : {} };
    } catch {
      return { data: {} };
    }
  }

  if (contentType === "application/x-www-form-urlencoded") {
    const text = await request.text();
    const params = new URLSearchParams(text);
    return { data: Object.fromEntries(params.entries()) };
  }

  if (contentType === "multipart/form-data") {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") data[key] = value;
    }
    return { data };
  }

  return { error: jsonResponse({ status: "error", msg: "نوع الطلب غير مدعوم." }, 415, id) };
}

function normalizeRequestValue(data, key, fallbackKey = "") {
  let value = data?.[key];
  if ((value == null || value === "") && fallbackKey) value = data?.[fallbackKey] ?? "";
  return ["string", "number", "boolean"].includes(typeof value) ? String(value).trim() : "";
}

function normalizeLookupValue(value, uppercase = false) {
  let normalized = String(value ?? "").trim().replace(/[\s\u200B-\u200D\uFEFF]+/gu, "");
  if (uppercase) normalized = normalized.toUpperCase();
  return normalized;
}

function compactLookupSql(expression) {
  return `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(${expression}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), '-', ''))`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function maskIdentity(identity) {
  const value = String(identity ?? "");
  return value.length <= 4 ? "*".repeat(value.length) : "*".repeat(value.length - 4) + value.slice(-4);
}

function firstNonEmpty(row, keys) {
  for (const key of keys) {
    if (row?.[key] != null && String(row[key]).trim() !== "") return String(row[key]);
  }
  return "";
}

function formatDate(value) {
  if (!value) return "";
  const text = String(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : text;
}

async function tableColumns(db, table) {
  const cacheKey = `${table}`;
  if (tableColumnCache.has(cacheKey)) return tableColumnCache.get(cacheKey);
  const [rows] = await db.execute(
    "SELECT COLUMN_NAME AS column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
    [table],
  );
  const set = new Set(rows.map((row) => String(row.column_name)));
  tableColumnCache.set(cacheKey, set);
  return set;
}

async function hasColumn(db, table, column) {
  return (await tableColumns(db, table)).has(column);
}

async function coalesceColumns(db, table, alias, columns, fallback = "''") {
  const parts = [];
  for (const column of columns) {
    if (await hasColumn(db, table, column)) parts.push(`NULLIF(${alias}.${column}, '')`);
  }
  if (!parts.length) return fallback;
  parts.push(fallback);
  return `COALESCE(${parts.join(", ")})`;
}

async function searchLeave(db, code, identity, active) {
  const patientNameExpr = await coalesceColumns(db, "patients", "p", ["name_ar", "name", "name_en"], "''");

  const doctorNameParts = [];
  for (const column of ["name_ar", "name", "name_en"]) {
    if (await hasColumn(db, "doctors", column)) doctorNameParts.push(`NULLIF(d.${column}, '')`);
  }
  if (await hasColumn(db, "sick_leaves", "doctor_name_en")) doctorNameParts.push("NULLIF(sl.doctor_name_en, '')");
  const doctorNameExpr = doctorNameParts.length ? `COALESCE(${[...doctorNameParts, "''"].join(", ")})` : "''";

  const doctorTitleParts = [];
  for (const column of ["title_ar", "title", "title_en"]) {
    if (await hasColumn(db, "doctors", column)) doctorTitleParts.push(`NULLIF(d.${column}, '')`);
  }
  if (await hasColumn(db, "sick_leaves", "doctor_title_en")) doctorTitleParts.push("NULLIF(sl.doctor_title_en, '')");
  const doctorTitleExpr = doctorTitleParts.length ? `COALESCE(${[...doctorTitleParts, "''"].join(", ")})` : "''";

  const companionNameExpr = (await hasColumn(db, "sick_leaves", "companion_name")) ? "sl.companion_name" : "''";
  const companionRelationExpr = (await hasColumn(db, "sick_leaves", "companion_relation")) ? "sl.companion_relation" : "''";
  const isCompanionExpr = (await hasColumn(db, "sick_leaves", "is_companion")) ? "sl.is_companion" : "0";

  let activeCondition;
  if (await hasColumn(db, "sick_leaves", "deleted_at")) {
    activeCondition = `sl.deleted_at IS ${active ? "NULL" : "NOT NULL"}`;
  } else if (await hasColumn(db, "sick_leaves", "is_deleted")) {
    activeCondition = `sl.is_deleted = ${active ? "0" : "1"}`;
  } else {
    activeCondition = active ? "1 = 1" : "1 = 0";
  }

  const serviceCodeCompactExpr = compactLookupSql("sl.service_code");
  const identityCompactExpr = compactLookupSql("p.identity_number");
  const sql = `
    SELECT
      sl.id AS leave_id,
      sl.service_code,
      p.identity_number,
      ${patientNameExpr} AS patient_name,
      sl.issue_date,
      sl.start_date,
      sl.end_date,
      sl.days_count,
      ${doctorNameExpr} AS doctor_name,
      ${doctorTitleExpr} AS doctor_title,
      ${isCompanionExpr} AS is_companion,
      ${companionNameExpr} AS companion_name,
      ${companionRelationExpr} AS companion_relation
    FROM sick_leaves sl
    INNER JOIN patients p ON p.id = sl.patient_id
    LEFT JOIN doctors d ON d.id = sl.doctor_id
    WHERE (UPPER(TRIM(sl.service_code)) = UPPER(?) OR ${serviceCodeCompactExpr} = ?)
      AND (TRIM(p.identity_number) = ? OR ${identityCompactExpr} = ?)
      AND ${activeCondition}
    ORDER BY sl.id DESC
    LIMIT 1
  `;

  const [rows] = await db.execute(sql, [
    code,
    normalizeLookupValue(code.replaceAll("-", ""), true),
    identity,
    normalizeLookupValue(identity.replaceAll("-", ""), true),
  ]);
  return rows[0] ?? null;
}

async function logLeaveQuery(db, leaveId, id, source = "external") {
  if (!envFlag("LOG_INQUIRIES", true)) return;
  try {
    await db.execute("INSERT INTO leave_queries (leave_id, queried_at, source) VALUES (?, NOW(), ?)", [leaveId, source]);
  } catch (error) {
    logError(id, `Unable to log leave query for leave #${leaveId}: ${error.message}`);
  }
}

function renderLeaveResult(row) {
  const serviceCode = escapeHtml(row.service_code ?? "");
  const identityNumber = escapeHtml(maskIdentity(row.identity_number ?? ""));
  const patientName = escapeHtml(firstNonEmpty(row, ["patient_name"]));
  const issueDate = escapeHtml(formatDate(row.issue_date ?? ""));
  const startDate = escapeHtml(formatDate(row.start_date ?? ""));
  const endDate = escapeHtml(formatDate(row.end_date ?? ""));
  const daysCount = escapeHtml(row.days_count ?? "");
  const doctorName = escapeHtml(firstNonEmpty(row, ["doctor_name"]));
  const doctorTitle = escapeHtml(firstNonEmpty(row, ["doctor_title"]));

  let companionBlock = "";
  if (row.is_companion && String(row.companion_name ?? "").trim() !== "") {
    companionBlock = `
      <div class="col-md-6"><span>اسم المرافق: </span>${escapeHtml(row.companion_name)}</div>
      <div class="col-md-6"><span>صلة القرابة: </span>${escapeHtml(row.companion_relation ?? "")}</div>`;
  }

  return `
    <div class="row justify-content-center mt-1">
      <div class="col-md-5 p-4">
        <div class="form-group mb-3" style="padding-bottom: 10px;">
          <input type="text" maxlength="20" placeholder="رمز الخدمة" class="form-control" value="${serviceCode}" readonly>
        </div>
        <div class="form-group mb-3">
          <input type="text" maxlength="10" pattern="\\d*" placeholder="رقم الهوية / الإقامة" class="form-control" value="${identityNumber}" readonly>
        </div>
        <div class="results-inquiery row">
          <div class="col-md-6"><span>الاسم: </span>${patientName}</div>
          ${companionBlock}
          <div class="col-md-6"><span>تاريخ إصدار تقرير الإجازة:</span> ${issueDate}</div>
          <div class="col-md-6"><span>تبدأ من:</span> ${startDate}</div>
          <div class="col-md-6"><span>وحتى:</span> ${endDate}</div>
          <div class="col-md-6"><span>المدة بالأيام:</span> ${daysCount}</div>
          <div class="col-md-6"><span>اسم الطبيب:</span> ${doctorName}</div>
          <div class="col-md-6"><span>المسمى الوظيفي:</span> ${doctorTitle}</div>
        </div>
        <a href="/" class="btn btn-primary mt-3">استعلام جديد</a>
      </div>
    </div>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(request) {
  const id = requestId();
  let db = null;

  try {
    if (request.method.toUpperCase() !== "POST") {
      return jsonResponse({ status: "error", msg: "طريقة الطلب غير مسموحة." }, 405, id, { allow: "POST" });
    }

    if (!requestOriginIsAllowed(request)) {
      return jsonResponse({ status: "error", msg: "مصدر الطلب غير مسموح." }, 403, id);
    }

    const parsed = await requestData(request, id);
    if (parsed.error) return parsed.error;

    const code = normalizeLookupValue(normalizeRequestValue(parsed.data, "code", "service_code"), true);
    const identity = normalizeLookupValue(normalizeRequestValue(parsed.data, "id", "identity_number"), false);

    if (!code) return jsonResponse({ status: "error", msg: "فضلاً اكتب رمز الخدمة" }, 422, id);
    if (!identity) return jsonResponse({ status: "error", msg: "فضلاً اكتب رقم الهوية" }, 422, id);
    if (!/^(?=.*[A-Z])(?=.*\d)[A-Z0-9-]{6,20}$/.test(code)) {
      return jsonResponse({ status: "error", msg: "رمز الخدمة غير صالح" }, 422, id);
    }
    if (!/^\d{10}$/.test(identity)) {
      return jsonResponse({ status: "error", msg: "رقم الهوية غير صالح" }, 422, id);
    }

    let config;
    try {
      config = databaseConfigFromEnvironment();
    } catch (error) {
      logError(id, `Database configuration failed: ${error.message}`);
      return jsonResponse({ status: "error", msg: "إعدادات الاتصال بالخادم غير مكتملة." }, 503, id);
    }

    try {
      db = await connectDatabase(config);
    } catch (error) {
      logError(id, `Connection failed: ${error.message}`);
      return jsonResponse({ status: "error", msg: "تعذّر الاتصال بالخادم حالياً. حاول مرة أخرى لاحقاً." }, 503, id);
    }

    try {
      const activeLeave = await searchLeave(db, code, identity, true);
      if (activeLeave) {
        await logLeaveQuery(db, Number(activeLeave.leave_id), id);
        return jsonResponse({ status: "ok", html: renderLeaveResult(activeLeave) }, 200, id);
      }

      const archivedLeave = await searchLeave(db, code, identity, false);
      if (archivedLeave) await logLeaveQuery(db, Number(archivedLeave.leave_id), id);
    } catch (error) {
      logError(id, `Search failed: ${error.message}`);
      return jsonResponse({ status: "error", msg: "تعذّر تنفيذ الاستعلام حالياً. حاول مرة أخرى لاحقاً." }, 503, id);
    }

    await sleep(randomInt(120, 261));
    return jsonResponse({ status: "notfound" }, 200, id);
  } catch (error) {
    logError(id, `Unhandled exception: ${error?.message || error}`);
    return jsonResponse({ status: "error", msg: "حدث خطأ داخلي أثناء تنفيذ الاستعلام. حاول مرة أخرى." }, 500, id);
  } finally {
    if (db) {
      try { await db.end(); } catch { /* ignore close errors */ }
    }
  }
}

export const config = {
  path: ["/search_service.php", "/folder/search_service.php"],
  rateLimit: {
    // Closely approximates the original 15 requests / 10 minutes within Netlify's 180-second window limit.
    windowLimit: 5,
    windowSize: 180,
    aggregateBy: ["ip", "domain"],
  },
};
