#!/usr/bin/env bash
set -e

# Force correct MPM
a2dismod mpm_event mpm_worker >/dev/null 2>&1 || true
a2enmod mpm_prefork >/dev/null 2>&1 || true

# 🚨 اجعل Apache يسمع على 80 (مطابق لـ Railway Edge)
PORT_TO_USE=80

cat > /etc/apache2/ports.conf <<EOF
Listen 0.0.0.0:${PORT_TO_USE}

<IfModule ssl_module>
    Listen 443
</IfModule>

<IfModule mod_gnutls.c>
    Listen 443
</IfModule>
EOF

sed -i "s/<VirtualHost \*:.*/<VirtualHost *:${PORT_TO_USE}>/" /etc/apache2/sites-available/000-default.conf || true

echo "Apache listening on 0.0.0.0:${PORT_TO_USE}"

exec apache2-foreground
