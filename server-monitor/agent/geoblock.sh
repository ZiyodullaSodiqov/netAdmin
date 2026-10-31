#!/usr/bin/env bash
# NetAdmin geo-blok: serverga faqat tanlangan davlat(lar) IP laridan (standart: O'zbekiston) kirishga ruxsat.
#
#   bash geoblock.sh enable [--all | --ports 22,80,443,9800] [--allow IP,CIDR,...] [--country UZ] [--no-telegram] [--confirm 180]
#   netadmin-geoblock confirm      # o'rnatgandan keyin ulanish ishlayotganini tasdiqlash
#   netadmin-geoblock status
#   netadmin-geoblock update       # IP ro'yxatini yangilash (haftada bir avtomatik)
#   netadmin-geoblock disable      # butunlay o'chirish
#
# Xavfsizlik choralari:
#   * buyruqni ishga tushirgan SSH mijozning IP si doim ruxsat etiladi;
#   * --confirm N: N soniya ichida `confirm` qilinmasa, qoidalar avtomatik olib tashlanadi;
#   * chiquvchi ulanishlar va ularning javoblari (apt, API so'rovlari) cheklanmaydi;
#   * DigitalOcean Recovery Console tarmoqqa bog'liq emas — u doim ishlaydi.
set -euo pipefail

NAME="netadmin-geoblock"
DIR="/etc/netadmin-geoblock"
BIN="/usr/local/sbin/$NAME"
TABLE="netadmin_geo"
RIPE_URL="https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest"
# Telegram serverlari (bot webhooklari uchun): https://core.telegram.org/resources/cidr.txt
TELEGRAM4="91.105.192.0/23,91.108.4.0/22,91.108.8.0/22,91.108.12.0/22,91.108.16.0/22,91.108.20.0/22,91.108.56.0/22,149.154.160.0/20,185.76.151.0/24"
TELEGRAM6="2001:67c:4e8::/48,2001:b28:f23c::/47,2001:b28:f23f::/48,2a0a:f280::/32"
PRIVATE4="127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16"
PRIVATE6="::1/128,fe80::/10,fc00::/7"

die() { echo "XATO: $*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "root huquqi kerak"; }

load_conf() {
  MODE="all"; PORTS="22,80,443,9800"; ALLOW=""; COUNTRY="UZ"; TELEGRAM=1; CONFIRMED=0; ENABLED=0
  # shellcheck disable=SC1091
  [[ -f "$DIR/config" ]] && . "$DIR/config"
  return 0
}

save_conf() {
  install -d -m 755 "$DIR"
  cat > "$DIR/config" <<EOF
MODE="$MODE"
PORTS="$PORTS"
ALLOW="$ALLOW"
COUNTRY="$COUNTRY"
TELEGRAM=$TELEGRAM
CONFIRMED=$CONFIRMED
ENABLED=$ENABLED
EOF
}

ensure_nft() {
  command -v nft >/dev/null && return
  echo "nftables o'rnatilmoqda…"
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -q nftables >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q nftables
  elif command -v yum >/dev/null; then yum install -y -q nftables
  else die "nft topilmadi va o'rnatib bo'lmadi"; fi
}

# RIPE reestridan davlat IP bloklarini yuklab olish (CIDR ko'rinishida)
fetch_lists() {
  install -d -m 755 "$DIR"
  local tmp; tmp=$(mktemp -d)
  echo "IP ro'yxati yuklanmoqda (RIPE NCC, davlat: $COUNTRY)…"
  if ! curl -fsSL --retry 3 --max-time 120 "$RIPE_URL" -o "$tmp/ripe.txt"; then
    rm -rf "$tmp"; die "RIPE ro'yxatini yuklab bo'lmadi — qoidalar o'zgartirilmadi"
  fi
  python3 - "$tmp/ripe.txt" "$COUNTRY" "$tmp/v4.txt" "$tmp/v6.txt" <<'PY'
import ipaddress, sys
src, countries, out4, out6 = sys.argv[1], set(sys.argv[2].upper().split(",")), sys.argv[3], sys.argv[4]
v4, v6 = [], []
for line in open(src, encoding="utf-8", errors="replace"):
    f = line.strip().split("|")
    if len(f) < 7 or f[1].upper() not in countries or f[6] not in ("allocated", "assigned"):
        continue
    if f[2] == "ipv4":
        start = ipaddress.IPv4Address(f[3])
        end = start + int(f[4]) - 1
        v4 += list(ipaddress.summarize_address_range(start, end))
    elif f[2] == "ipv6":
        v6.append(ipaddress.IPv6Network("%s/%s" % (f[3], f[4]), strict=False))
open(out4, "w").write("\n".join(str(n) for n in ipaddress.collapse_addresses(v4)) + "\n")
open(out6, "w").write("\n".join(str(n) for n in ipaddress.collapse_addresses(v6)) + "\n")
PY
  local n4; n4=$(grep -c . "$tmp/v4.txt" || true)
  [[ "$n4" -ge 20 ]] || { rm -rf "$tmp"; die "ro'yxat juda kichik ($n4 ta) — xavfli, qoidalar o'zgartirilmadi"; }
  mv "$tmp/v4.txt" "$DIR/allow4.country"; mv "$tmp/v6.txt" "$DIR/allow6.country"
  date +%s > "$DIR/updated"
  rm -rf "$tmp"
  echo "  IPv4 bloklari: $n4, IPv6 bloklari: $(grep -c . "$DIR/allow6.country" || true)"
}

join_file() { grep -v '^\s*$' "$1" | paste -sd, -; }

split_allow() {  # ALLOW ichidagi IPv4 / IPv6 ni ajratish
  local fam=$1 out=() x
  IFS=',' read -ra items <<< "$ALLOW"
  for x in "${items[@]}"; do
    x="${x// /}"; [[ -z "$x" ]] && continue
    if [[ "$fam" == 6 && "$x" == *:* ]] || [[ "$fam" == 4 && "$x" != *:* ]]; then out+=("$x"); fi
  done
  (IFS=,; echo "${out[*]:-}")
}

build_rules() {
  local c4 c6 a4 a6 pub match
  c4=$(join_file "$DIR/allow4.country"); c6=$(join_file "$DIR/allow6.country" || true)
  a4="$PRIVATE4"; a6="$PRIVATE6"
  [[ "$TELEGRAM" == 1 ]] && a4="$a4,$TELEGRAM4" && a6="$a6,$TELEGRAM6"
  local u4 u6; u4=$(split_allow 4); u6=$(split_allow 6)
  [[ -n "$u4" ]] && a4="$a4,$u4"
  [[ -n "$u6" ]] && a6="$a6,$u6"
  if [[ "$MODE" == "ports" ]]; then
    match="meta l4proto { tcp, udp } th dport != { $PORTS } accept"
  else
    match=""
  fi
  pub=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
  {
    echo "table inet $TABLE"
    echo "delete table inet $TABLE"
    echo "table inet $TABLE {"
    echo "  set country4 { type ipv4_addr; flags interval; auto-merge; elements = { $c4 } }"
    [[ -n "$c6" ]] && echo "  set country6 { type ipv6_addr; flags interval; auto-merge; elements = { $c6 } }"
    echo "  set allow4 { type ipv4_addr; flags interval; auto-merge; elements = { $a4 } }"
    echo "  set allow6 { type ipv6_addr; flags interval; auto-merge; elements = { $a6 } }"
    echo "  set open_ports { type inet_service; }   # certbot yangilanishi paytida vaqtincha 80"
    for chain in input forward; do
      echo "  chain $chain {"
      if [[ "$chain" == input ]]; then
        echo "    type filter hook input priority -10; policy accept;"
        echo "    iif lo accept"
      else
        [[ -z "$pub" ]] && { echo "    type filter hook forward priority -10; policy accept;"; echo "  }"; continue; }
        echo "    type filter hook forward priority -10; policy accept;"
        echo "    iifname != \"$pub\" accept   # konteynerlardan chiquvchi trafik"
      fi
      echo "    ct state established,related accept"
      echo "    meta l4proto { icmp, ipv6-icmp } accept"
      [[ -n "$match" ]] && echo "    $match"
      echo "    tcp dport @open_ports accept"
      echo "    ip saddr @allow4 accept"
      echo "    ip saddr @country4 accept"
      echo "    ip6 saddr @allow6 accept"
      [[ -n "$c6" ]] && echo "    ip6 saddr @country6 accept"
      echo "    counter drop comment \"netadmin-geoblock\""
      echo "  }"
    done
    echo "}"
  } > "$DIR/rules.nft"
}

apply_rules() {
  build_rules
  nft -c -f "$DIR/rules.nft" || die "nft qoidalarida xato — o'zgartirilmadi"
  nft -f "$DIR/rules.nft"
}

install_self() {
  install -m 755 "$(readlink -f "$0")" "$BIN" 2>/dev/null || true
  cat > /etc/systemd/system/$NAME.service <<EOF
[Unit]
Description=NetAdmin geo-blok (faqat tanlangan davlat IP lari)
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=$BIN load
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/$NAME-update.service <<EOF
[Unit]
Description=NetAdmin geo-blok: IP ro'yxatini yangilash

[Service]
Type=oneshot
ExecStart=$BIN update
EOF
  cat > /etc/systemd/system/$NAME-update.timer <<EOF
[Unit]
Description=NetAdmin geo-blok: haftalik yangilash

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  if [[ -d /etc/letsencrypt ]]; then  # SSL yangilanishi paytida 80-portni hamma uchun vaqtincha ochish
    install -d /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
    printf '#!/bin/sh\nnft add element inet %s open_ports { 80 } 2>/dev/null || true\n' "$TABLE" > /etc/letsencrypt/renewal-hooks/pre/$NAME.sh
    printf '#!/bin/sh\nnft delete element inet %s open_ports { 80 } 2>/dev/null || true\n' "$TABLE" > /etc/letsencrypt/renewal-hooks/post/$NAME.sh
    chmod 755 /etc/letsencrypt/renewal-hooks/pre/$NAME.sh /etc/letsencrypt/renewal-hooks/post/$NAME.sh
  fi
  systemctl daemon-reload
}

cancel_rollback() {
  systemctl stop "$NAME-rollback.timer" 2>/dev/null || true
  systemctl reset-failed "$NAME-rollback.service" "$NAME-rollback.timer" 2>/dev/null || true
}

cmd_enable() {
  need_root
  load_conf
  local confirm=180 extra=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) MODE="all"; shift ;;
      --ports) MODE="ports"; PORTS="$2"; shift 2 ;;
      --allow) extra="$2"; shift 2 ;;
      --country) COUNTRY="$2"; shift 2 ;;
      --no-telegram) TELEGRAM=0; shift ;;
      --confirm) confirm="$2"; shift 2 ;;
      *) die "noma'lum parametr: $1" ;;
    esac
  done
  [[ "$COUNTRY" =~ ^[A-Za-z]{2}(,[A-Za-z]{2})*$ ]] || die "davlat kodi noto'g'ri: $COUNTRY"
  [[ "$PORTS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "portlar noto'g'ri: $PORTS"
  [[ -z "$extra" || "$extra" =~ ^[0-9A-Fa-f.:/,]+$ ]] || die "--allow qiymati noto'g'ri"
  # buyruqni ishga tushirgan SSH mijoz doim ruxsat etiladi (o'zimizni bloklab qo'ymaslik uchun)
  local me="${SSH_CLIENT%% *}"
  ALLOW=$(echo "$ALLOW,$extra,$me" | tr ',' '\n' | grep -v '^\s*$' | sort -u | paste -sd, -)
  ensure_nft
  [[ -s "$DIR/allow4.country" && "$(cat "$DIR/country" 2>/dev/null)" == "$COUNTRY" ]] || fetch_lists
  echo "$COUNTRY" > "$DIR/country"
  install_self
  cancel_rollback
  apply_rules
  ENABLED=1
  if [[ "$confirm" -gt 0 ]]; then
    CONFIRMED=0
    systemd-run --quiet --unit "$NAME-rollback" --on-active="${confirm}s" "$BIN" rollback
    echo "Geo-blok yoqildi. ${confirm} soniya ichida '$NAME confirm' bajarilmasa, avtomatik bekor qilinadi."
  else
    CONFIRMED=1
    echo "Geo-blok yoqildi."
  fi
  save_conf
  systemctl enable --quiet $NAME.service $NAME-update.timer
  systemctl start --quiet $NAME-update.timer
  local mode_txt="barcha portlar" allow_txt="$ALLOW"
  [[ "$MODE" == "ports" ]] && mode_txt="portlar $PORTS"
  [[ -z "$allow_txt" ]] && allow_txt="yo'q"
  echo "Rejim: $mode_txt, davlat: $COUNTRY, qo'shimcha ruxsat: $allow_txt"
}

cmd_confirm() {
  need_root; load_conf
  cancel_rollback
  CONFIRMED=1; save_conf
  echo "Tasdiqlandi — geo-blok doimiy (qayta yuklashdan keyin ham ishlaydi)."
}

cmd_rollback() {
  load_conf
  [[ "$CONFIRMED" == 1 ]] && exit 0
  nft delete table inet "$TABLE" 2>/dev/null || true
  ENABLED=0; save_conf
  systemctl disable --quiet $NAME.service 2>/dev/null || true
  logger -t "$NAME" "tasdiqlanmadi — geo-blok avtomatik olib tashlandi"
}

cmd_disable() {
  need_root; load_conf
  cancel_rollback
  nft delete table inet "$TABLE" 2>/dev/null || true
  ENABLED=0; CONFIRMED=0; save_conf
  systemctl disable --quiet --now $NAME.service $NAME-update.timer 2>/dev/null || true
  rm -f /etc/letsencrypt/renewal-hooks/pre/$NAME.sh /etc/letsencrypt/renewal-hooks/post/$NAME.sh
  echo "Geo-blok o'chirildi — barcha davlatlardan kirish ochiq."
}

cmd_load() {
  load_conf
  [[ "$ENABLED" == 1 && "$CONFIRMED" == 1 ]] || exit 0
  apply_rules
}

cmd_update() {
  need_root; load_conf
  fetch_lists
  [[ "$ENABLED" == 1 ]] && apply_rules && echo "Qoidalar yangilandi."
  return 0
}

cmd_status() {
  load_conf
  local active=0 dropped=0
  if nft list table inet "$TABLE" >/dev/null 2>&1; then
    active=1
    dropped=$(nft list table inet "$TABLE" 2>/dev/null | awk '/counter packets/ {for(i=1;i<=NF;i++) if($i=="packets") s+=$(i+1)} END {print s+0}')
  fi
  local n4=0 upd=0
  [[ -s "$DIR/allow4.country" ]] && n4=$(grep -c . "$DIR/allow4.country" || true)
  [[ -s "$DIR/updated" ]] && upd=$(tr -dc 0-9 < "$DIR/updated")
  echo "{\"active\": $active, \"enabled\": $ENABLED, \"confirmed\": $CONFIRMED, \"mode\": \"$MODE\", \"ports\": \"$PORTS\", \"country\": \"$COUNTRY\", \"dropped\": ${dropped:-0}, \"prefixes4\": ${n4:-0}, \"updated\": ${upd:-0}}"
}

case "${1:-}" in
  enable) shift; cmd_enable "$@" ;;
  confirm) cmd_confirm ;;
  rollback) cmd_rollback ;;
  disable) cmd_disable ;;
  load) cmd_load ;;
  update) cmd_update ;;
  status) cmd_status ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
