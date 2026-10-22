#!/usr/bin/env bash
# NetAdmin agentini serverga o'rnatish (systemd servis sifatida).
#
#   sudo bash install.sh --token <TOKEN> [--port 9800] [--allow <dashboard IP>] [--access-log "/var/log/nginx/*.log"]
#
# Token berilmasa avtomatik yaratiladi va ekranga chiqariladi.
# O'chirish:  sudo bash install.sh --uninstall
set -euo pipefail

TOKEN=""
PORT="9800"
ALLOW=""
ACCESS_LOGS=""
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --allow) ALLOW="$2"; shift 2 ;;
    --access-log) ACCESS_LOGS="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Noma'lum parametr: $1"; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "root huquqi kerak: sudo bash install.sh ..."; exit 1
fi

if [[ $UNINSTALL -eq 1 ]]; then
  systemctl disable --now netadmin-agent 2>/dev/null || true
  rm -f /etc/systemd/system/netadmin-agent.service /etc/netadmin-agent.env
  rm -rf /opt/netadmin-agent
  systemctl daemon-reload
  echo "NetAdmin agent o'chirildi."; exit 0
fi

command -v python3 >/dev/null || { echo "python3 topilmadi. O'rnating: apt install python3 / yum install python3"; exit 1; }

if [[ -z "$TOKEN" ]]; then
  TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d -m 755 /opt/netadmin-agent
install -m 755 "$DIR/netadmin_agent.py" /opt/netadmin-agent/netadmin_agent.py

umask 077
cat > /etc/netadmin-agent.env <<EOF
NETADMIN_TOKEN=$TOKEN
NETADMIN_PORT=$PORT
NETADMIN_ALLOW=$ALLOW
NETADMIN_ACCESS_LOGS=$ACCESS_LOGS
EOF
chmod 600 /etc/netadmin-agent.env

cat > /etc/systemd/system/netadmin-agent.service <<'EOF'
[Unit]
Description=NetAdmin monitoring agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/netadmin-agent.env
ExecStart=/usr/bin/env python3 /opt/netadmin-agent/netadmin_agent.py
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now netadmin-agent
systemctl restart netadmin-agent

# Firewall: port ochish (faqat dashboard IP siga, agar berilgan bo'lsa)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  if [[ -n "$ALLOW" ]]; then
    IFS=',' read -ra IPS <<< "$ALLOW"
    for ip in "${IPS[@]}"; do ufw allow from "$ip" to any port "$PORT" proto tcp >/dev/null; done
  else
    ufw allow "$PORT"/tcp >/dev/null
  fi
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT"/tcp >/dev/null && firewall-cmd --reload >/dev/null
fi

sleep 1
if curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || systemctl is-active --quiet netadmin-agent; then
  echo
  echo "✅ NetAdmin agent ishga tushdi"
  echo "   Port : $PORT"
  echo "   Token: $TOKEN"
  echo
  echo "Dashboardga shu serverning IP manzili, port va tokenni kiriting."
else
  echo "❌ Agent ishga tushmadi. Ko'ring: journalctl -u netadmin-agent -n 50"; exit 1
fi
