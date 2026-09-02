#!/bin/sh
# Start the inbox and open it in a browser. Windows: use start-inbox.cmd.
cd "$(dirname "$0")" || exit 1

URL="http://127.0.0.1:${AGENT_INBOX_PORT:-7717}"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
fi

exec node server.js
