#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/app}"
mkdir -p "$APP_DIR"

cat > "$APP_DIR/hello.txt" <<'EOF'
Hello, world!
EOF

cat > "$APP_DIR/hello.sh" <<'EOF'
#!/usr/bin/env bash
printf 'Hello, world!\n'
EOF
chmod +x "$APP_DIR/hello.sh"
