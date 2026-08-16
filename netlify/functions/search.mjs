import mysql from 'mysql2/promise';

const MAX_REQUEST_BYTES = 4096;
let pool;
const schemaCache = new Map();

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function boolEnv(name, fallback = false) {
  const value = env(name);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      ...extraHeaders,
    },
  });
}

function databaseConfig() {
  const url = env('MYSQL_PUBLIC_URL') || env('DATABASE_URL') || env('MYSQL_URL');
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'mysql:') throw new Error('Database URL must use mysql://');
    if (!parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
      throw new Error('Database URL is incomplete');
    }
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password || ''),
      database: decodeURIComponent(parsed.pathname.slice(1)),
    };
  }

  const host = env('MYSQLHOST');
  const user = env('MYSQLUSER');
  const password = env('MYSQLPASSWORD');
  const database = env('MYSQLDATABASE');
  const port = Number(env('MYSQLPORT', '3306'));
  if (!host || !user || password === undefined || !database || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MySQL environment variables are missing or invalid');
  }
  return { host, port, user, password, database };
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...databaseConfig(),
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 4,
      maxIdle: 2,
      idleTimeout: 60000,
      queueLimit: 20,
      connectTimeout: 6000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      dateStrings: true,
    });
  }
  return pool;
}

function normalize(value, upper = false) {
  const clean = String(value ?? '').trim().replace(/[\s\u200B-\u200D\uFEFF]+/gu, '');
  return upper ? clean.toUpperCase() : clean;
}

function compactSql(expression) {
  return `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(${expression}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), '-', ''))`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function maskIdentity(value) {
  const text = String(value ?? '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return '*'.repeat(text.length - 4) + text.slice(-4);
}

function formatDate(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : text;
}

async function tableColumns(db, table) {
  if (schemaCache.has(table)) return schemaCache.get(table);
  const [rows] = await db.execute(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  );
  const set = new Set(rows.map((row) => row.column_name));
  schemaCache.set(table, set);
  return set;
}

async function coalesceColumns(db, table, alias, candidates, fallback = "''") {
  const columns = await tableColumns(db, table);
  const parts = candidates.filter((col) => columns.has(col)).map((col) => `NULLIF(${alias}.${col}, '')`);
  return parts.length ? `COALESCE(${[...parts, fallback].join(', ')})` : fallback;
}

async function searchLeave(db, code, identity, active) {
  const sick = await tableColumns(db, 'sick_leaves');
  const doctors = await tableColumns(db, 'doctors');
  const patientNameExpr = await coalesceColumns(db, 'patients', 'p', ['name_ar', 'name', 'name_en']);

  const doctorNameParts = ['name_ar', 'name', 'name_en']
    .filter((col) => doctors.has(col))
    .map((col) => `NULLIF(d.${col}, '')`);
  if (sick.has('doctor_name_en')) doctorNameParts.push("NULLIF(sl.doctor_name_en, '')");
  const doctorNameExpr = doctorNameParts.length ? `COALESCE(${[...doctorNameParts, "''"].join(', ')})` : "''";

  const doctorTitleParts = ['title_ar', 'title', 'title_en']
    .filter((col) => doctors.has(col))
    .map((col) => `NULLIF(d.${col}, '')`);
  if (sick.has('doctor_title_en')) doctorTitleParts.push("NULLIF(sl.doctor_title_en, '')");
  const doctorTitleExpr = doctorTitleParts.length ? `COALESCE(${[...doctorTitleParts, "''"].join(', ')})` : "''";

  const companionNameExpr = sick.has('companion_name') ? 'sl.companion_name' : "''";
  const companionRelationExpr = sick.has('companion_relation') ? 'sl.companion_relation' : "''";
  const isCompanionExpr = sick.has('is_companion') ? 'sl.is_companion' : '0';

  let activeCondition = active ? '1 = 1' : '1 = 0';
  if (sick.has('deleted_at')) activeCondition = `sl.deleted_at IS ${active ? 'NULL' : 'NOT NULL'}`;
  else if (sick.has('is_deleted')) activeCondition = `sl.is_deleted = ${active ? '0' : '1'}`;

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
    WHERE (UPPER(TRIM(sl.service_code)) = UPPER(?)
           OR ${compactSql('sl.service_code')} = ?)
      AND (TRIM(p.identity_number) = ?
           OR ${compactSql('p.identity_number')} = ?)
      AND ${activeCondition}
    ORDER BY sl.id DESC
    LIMIT 1
  `;

  const [rows] = await db.execute(sql, [
    code,
    normalize(code.replaceAll('-', ''), true),
    identity,
    normalize(identity.replaceAll('-', ''), true),
  ]);
  return rows[0] || null;
}

async function logQuery(db, leaveId) {
  if (!boolEnv('LOG_INQUIRIES', true)) return;
  try {
    await db.execute(
      'INSERT INTO leave_queries (leave_id, queried_at, source) VALUES (?, NOW(), ?)',
      [leaveId, 'external-netlify'],
    );
  } catch (error) {
    console.warn('Inquiry logging skipped:', error?.message || error);
  }
}

function renderResult(row) {
  const serviceCode = escapeHtml(row.service_code);
  const identity = escapeHtml(maskIdentity(row.identity_number));
  const patientName = escapeHtml(row.patient_name);
  const issueDate = escapeHtml(formatDate(row.issue_date));
  const startDate = escapeHtml(formatDate(row.start_date));
  const endDate = escapeHtml(formatDate(row.end_date));
  const days = escapeHtml(row.days_count);
  const doctorName = escapeHtml(row.doctor_name);
  const doctorTitle = escapeHtml(row.doctor_title);

  const companion = row.is_companion && String(row.companion_name || '').trim()
    ? `<div class="col-md-6"><span>اسم المرافق: </span>${escapeHtml(row.companion_name)}</div>
       <div class="col-md-6"><span>صلة القرابة: </span>${escapeHtml(row.companion_relation)}</div>`
    : '';

  return `
    <div class="row justify-content-center mt-1">
      <div class="col-md-5 p-4">
        <div class="form-group mb-3" style="padding-bottom:10px">
          <input type="text" class="form-control" value="${serviceCode}" readonly>
        </div>
        <div class="form-group mb-3">
          <input type="text" class="form-control" value="${identity}" readonly>
        </div>
        <div class="results-inquiery row">
          <div class="col-md-6"><span>الاسم: </span>${patientName}</div>
          ${companion}
          <div class="col-md-6"><span>تاريخ إصدار التقرير:</span> ${issueDate}</div>
          <div class="col-md-6"><span>تبدأ من:</span> ${startDate}</div>
          <div class="col-md-6"><span>وحتى:</span> ${endDate}</div>
          <div class="col-md-6"><span>المدة بالأيام:</span> ${days}</div>
          <div class="col-md-6"><span>اسم الطبيب:</span> ${doctorName}</div>
          <div class="col-md-6"><span>المسمى الوظيفي:</span> ${doctorTitle}</div>
        </div>
        <a href="/#/inquiries/slenquiry" class="btn btn-primary mt-3" onclick="window.location.reload()">استعلام جديد</a>
      </div>
    </div>`;
}

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const configured = env('ALLOWED_ORIGINS');
  if (configured) {
    const allowed = configured.split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
    return allowed.includes(origin.replace(/\/$/, ''));
  }
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function readInput(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) return await request.json();
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  throw Object.assign(new Error('Unsupported content type'), { status: 415 });
}

export default async (request) => {
  if (request.method !== 'POST') return json({ status: 'error', msg: 'طريقة الطلب غير مسموحة.' }, 405, { allow: 'POST' });
  if (!originAllowed(request)) return json({ status: 'error', msg: 'مصدر الطلب غير مسموح.' }, 403);

  try {
    const data = await readInput(request);
    const code = normalize(data.code || data.service_code, true);
    const identity = normalize(data.id || data.identity_number, false);

    if (!code) return json({ status: 'error', msg: 'فضلاً اكتب رمز الخدمة' }, 422);
    if (!identity) return json({ status: 'error', msg: 'فضلاً اكتب رقم الهوية' }, 422);
    if (!/^(?=.*[A-Z])(?=.*\d)[A-Z0-9-]{6,20}$/.test(code)) return json({ status: 'error', msg: 'رمز الخدمة غير صالح' }, 422);
    if (!/^\d{10}$/.test(identity)) return json({ status: 'error', msg: 'رقم الهوية غير صالح' }, 422);

    const db = getPool();
    const active = await searchLeave(db, code, identity, true);
    if (active) {
      await logQuery(db, active.leave_id);
      return json({ status: 'ok', html: renderResult(active) });
    }

    const archived = await searchLeave(db, code, identity, false);
    if (archived) await logQuery(db, archived.leave_id);
    await new Promise((resolve) => setTimeout(resolve, 140 + Math.floor(Math.random() * 100)));
    return json({ status: 'notfound' });
  } catch (error) {
    console.error('search failure:', error?.message || error);
    const status = Number(error?.status) || 503;
    const message = status === 413
      ? 'حجم الطلب أكبر من المسموح.'
      : status === 415
        ? 'نوع الطلب غير مدعوم.'
        : /environment variables|Database URL/i.test(error?.message || '')
          ? 'إعدادات الاتصال بقاعدة البيانات غير مكتملة.'
          : 'تعذّر تنفيذ الاستعلام حالياً. حاول مرة أخرى لاحقاً.';
    return json({ status: 'error', msg: message }, status);
  }
};
