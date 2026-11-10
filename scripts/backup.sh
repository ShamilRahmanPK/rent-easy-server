#!/usr/bin/env bash
# Daily backup of the database and the uploaded files. Keeps 30 days.
# Cron example (every day at 02:30):  30 2 * * * /path/to/server/scripts/backup.sh >> /var/log/propy-lease-hub-backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

# Read only what is needed; the rest of .env is not shell syntax.
read_env() { grep -E "^$1=" .env | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
DATABASE_URL="${DATABASE_URL:-$(read_env DATABASE_URL)}"
UPLOAD_DIR="${UPLOAD_DIR:-$(read_env UPLOAD_DIR)}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# pg_dump does not understand Prisma's ?schema=... option.
DB_URL="${DATABASE_URL%%\?*}"

pg_dump --format=custom --no-owner --file "$BACKUP_DIR/db-$STAMP.dump" "$DB_URL"
tar -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" -C "${UPLOAD_DIR:-./uploads}" .

find "$BACKUP_DIR" -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +30 -delete
echo "Backup finished: $BACKUP_DIR/db-$STAMP.dump"
