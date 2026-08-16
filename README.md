# Netlify-ready inquiry demo

This project is ready for Netlify and uses a Netlify Function instead of PHP.
The browser route is always:

`https://YOUR-DOMAIN/#/inquiries/slenquiry`

## Deploy

1. Upload this folder/repository to Netlify (Git deployment is recommended).
2. In Netlify: **Project configuration → Environment variables**, add `MYSQL_PUBLIC_URL`.
3. Set `MYSQL_PUBLIC_URL` to the public MySQL connection string for the database that contains `sick_leaves`, `patients`, and `doctors`.
4. Deploy/redeploy.

### Railway MySQL

If the MySQL database currently lives on Railway, enable **Public Access** for that database and copy its `MYSQL_PUBLIC_URL`. Do **not** use a `*.railway.internal` host from Netlify because that is Railway-private networking.

## Supported database variables

Preferred: `MYSQL_PUBLIC_URL`.
Also supported: `DATABASE_URL`, `MYSQL_URL`, or the individual `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE` variables.

## Files

- `public/index.html` — frontend and hash route
- `public/assets/index.css` — existing visual stylesheet
- `netlify/functions/search.mjs` — MySQL-backed search function
- `netlify.toml` — Netlify publish/function/API rewrite configuration
- `.env.example` — environment variable template

## Safety/branding

The deployable version is intentionally marked as an unofficial demo and does not claim to be a Ministry/government service.
