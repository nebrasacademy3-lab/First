FROM composer:2 AS composer

# PHP مستقر يحتوي على Apache وDebian
FROM php:8.4-apache-bookworm

# أداة تثبيت إضافات PHP
ADD https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/install-php-extensions

RUN chmod +x /usr/local/bin/install-php-extensions

# إضافات PHP
RUN install-php-extensions \
    gd \
    pdo_mysql \
    mbstring \
    zip \
    opcache

# تشغيل MPM Prefork فقط ومنع تعارض MPM
RUN set -eux; \
    rm -f /etc/apache2/mods-enabled/mpm_event.*; \
    rm -f /etc/apache2/mods-enabled/mpm_worker.*; \
    a2enmod mpm_prefork; \
    a2enmod rewrite headers expires deflate; \
    apache2ctl configtest

# تثبيت Python وWeasyPrint والخطوط العربية
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libpangocairo-1.0-0 \
        libcairo2 \
        libgdk-pixbuf-2.0-0 \
        libffi-dev \
        shared-mime-info \
        fontconfig \
        fonts-inter \
        fonts-noto-core \
        fonts-liberation \
        fonts-dejavu-core \
    && python3 -m venv /opt/weasyprint \
    && /opt/weasyprint/bin/pip install \
        --no-cache-dir \
        --upgrade pip setuptools wheel \
    && /opt/weasyprint/bin/pip install \
        --no-cache-dir \
        weasyprint \
    && fc-cache -f \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# توفير Python وWeasyPrint لعمليات Apache وPHP
ENV PATH="/opt/weasyprint/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# التحقق من عمل Python وWeasyPrint
RUN python3 --version \
    && weasyprint --version \
    && echo "Python path: $(which python3)" \
    && echo "WeasyPrint path: $(which weasyprint)"

# نسخ Composer
COPY --from=composer /usr/bin/composer /usr/local/bin/composer

# مجلد المشروع
WORKDIR /var/www/html

# نسخ ملفات المشروع
COPY . .

ENV COMPOSER_ALLOW_SUPERUSER=1

# تثبيت مكتبات Composer
RUN if [ -f /var/www/html/composer.json ]; then \
        cd /var/www/html \
        && composer install \
            --no-dev \
            --optimize-autoloader \
            --no-interaction \
            --no-progress; \
    fi \
    && if [ -f /var/www/html/sickleave/composer.json ]; then \
        cd /var/www/html/sickleave \
        && composer install \
            --no-dev \
            --optimize-autoloader \
            --no-interaction \
            --no-progress; \
    fi

# مجلد آمن ومؤقت لملفات PDF
RUN install -d \
        -o www-data \
        -g www-data \
        -m 0750 \
        /tmp/weasyprint \
    && chown -R www-data:www-data /var/www/html

# إعداد Apache وتأمين الملفات الحساسة
RUN printf '%s\n' \
    'ServerName localhost' \
    'ServerTokens Prod' \
    'ServerSignature Off' \
    '<Directory /var/www/html>' \
    '    Options -Indexes +FollowSymLinks' \
    '    AllowOverride All' \
    '    Require all granted' \
    '</Directory>' \
    '<FilesMatch "^(\.env|composer\.(json|lock)|.*\.(sql|log))$">' \
    '    Require all denied' \
    '</FilesMatch>' \
    > /etc/apache2/conf-available/application.conf \
    && a2enconf application \
    && apache2ctl configtest

# إعداد PHP للأمان والأداء
RUN printf '%s\n' \
    'expose_php = Off' \
    'display_errors = Off' \
    'display_startup_errors = Off' \
    'log_errors = On' \
    'upload_max_filesize = 20M' \
    'post_max_size = 25M' \
    'memory_limit = 512M' \
    'max_execution_time = 120' \
    'max_input_time = 60' \
    'max_input_vars = 1000' \
    'session.use_strict_mode = 1' \
    'session.use_only_cookies = 1' \
    'session.cookie_httponly = 1' \
    'opcache.enable = 1' \
    'opcache.memory_consumption = 128' \
    'opcache.interned_strings_buffer = 16' \
    'opcache.max_accelerated_files = 10000' \
    'opcache.validate_timestamps = 0' \
    'realpath_cache_size = 4096K' \
    'realpath_cache_ttl = 600' \
    > /usr/local/etc/php/conf.d/production.ini

# ملف تشغيل Apache على منفذ Railway
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    '' \
    'LISTEN_PORT="${PORT:-8080}"' \
    '' \
    '# حذف ملفات Event وWorker بالكامل' \
    'rm -f /etc/apache2/mods-enabled/mpm_event.*' \
    'rm -f /etc/apache2/mods-enabled/mpm_worker.*' \
    '' \
    '# تفعيل Prefork فقط' \
    'a2enmod mpm_prefork >/dev/null 2>&1' \
    '' \
    '# ضبط منفذ Railway' \
    'sed -ri "s!^Listen [0-9]+!Listen ${LISTEN_PORT}!" /etc/apache2/ports.conf' \
    'sed -ri "s!<VirtualHost \*:[0-9]+>!<VirtualHost *:${LISTEN_PORT}>!" /etc/apache2/sites-available/000-default.conf' \
    '' \
    '# فحص الإعدادات' \
    'apache2ctl configtest' \
    '' \
    'echo "Starting Apache on port ${LISTEN_PORT}"' \
    'exec apache2-foreground' \
    > /usr/local/bin/start.sh \
    && chmod +x /usr/local/bin/start.sh

EXPOSE 8080

CMD ["/usr/local/bin/start.sh"]
