#!/bin/sh
# Runs in the db-backup container (docker-compose.yml): writes a dump of the site's database into /backups once a day,
# and keeps 14 days of them. A stopgap until backups are done properly in a later part of the client portal.
#
# Restore one (this replaces what's in the database):
#   docker compose exec db-backup pg_restore --clean --if-exists -d horizons /backups/horizons-YYYY-MM-DD.dump

set -u

while true; do
    stamp=$(date +%Y-%m-%d)
    if pg_dump --format=custom --file="/backups/horizons-$stamp.dump.partial"; then
        mv "/backups/horizons-$stamp.dump.partial" "/backups/horizons-$stamp.dump"
        echo "db-backup: wrote horizons-$stamp.dump"
    else
        rm -f "/backups/horizons-$stamp.dump.partial"
        echo "db-backup: pg_dump failed, trying again tomorrow" >&2
    fi
    find /backups -name 'horizons-*.dump' -mtime +13 -delete
    sleep 86400
done
