#!/usr/bin/env python3
"""
NetAdmin Monitor — bitta buyruq bilan o'rnatish va ishga tushirish.

    python3 start.py              # dashboard + shu kompyuter agenti, brauzer ochiladi
    python3 start.py --install    # avtomatik ishga tushadigan qilib o'rnatish (Linux / Windows / macOS)
    python3 start.py --uninstall  # avtomatik ishga tushishni o'chirish

Shu kompyuter Linux bo'lsa, uning agenti ham ishga tushadi va dashboardga
"Bu kompyuter" nomi bilan avtomatik qo'shiladi. Qolgan parametrlar
(--port, --interval, --password, ...) dashboardga uzatiladi.
"""

import argparse
import os
import platform
import secrets
import subprocess
import sys
import threading
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
DASHBOARD = os.path.join(HERE, "dashboard", "server.py")
AGENT = os.path.join(HERE, "agent", "netadmin_agent.py")
TOKEN_FILE = os.path.join(HERE, "dashboard", "local_agent.token")
SERVICE = "netadmin-monitor"
SYSTEM = platform.system()


def local_token():
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
        if tok:
            return tok
    tok = secrets.token_hex(24)
    with open(TOKEN_FILE, "w") as f:
        f.write(tok)
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    return tok


def register_local(db_path, port, token):
    """Shu kompyuterni dashboard bazasiga qo'shadi (yoki tokenini yangilaydi)."""
    sys.path.insert(0, os.path.join(HERE, "dashboard"))
    from server import DB  # jadvallarni ham yaratadi
    db = DB(db_path)
    row = db.q("SELECT id FROM servers WHERE host='127.0.0.1' AND port=?", (port,), one=True)
    if row:
        db.x("UPDATE servers SET token=? WHERE id=?", (token, row["id"]))
    else:
        db.x("INSERT INTO servers(name, host, port, token, grp, notes, created) VALUES (?,?,?,?,?,?,?)",
             ("Bu kompyuter (%s)" % platform.node(), "127.0.0.1", port, token, "Lokal",
              "start.py tomonidan avtomatik qo'shilgan", time.time()))
    db.conn.close()


# --------------------------------------------------------------------------- autostart

def install(passthrough, args):
    cmd_args = [os.path.abspath(__file__), "--no-browser"] + passthrough
    if args.no_agent:
        cmd_args.append("--no-agent")
    if SYSTEM == "Linux":
        if os.geteuid() != 0:
            sys.exit("Linuxda o'rnatish uchun root kerak:  sudo python3 start.py --install")
        unit = """[Unit]
Description=NetAdmin Monitor (dashboard + lokal agent)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s %s
WorkingDirectory=%s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
""" % (sys.executable, " ".join('"%s"' % a for a in cmd_args), HERE)
        with open("/etc/systemd/system/%s.service" % SERVICE, "w") as f:
            f.write(unit)
        subprocess.call(["systemctl", "daemon-reload"])
        subprocess.call(["systemctl", "enable", "--now", SERVICE])
        subprocess.call(["systemctl", "restart", SERVICE])
        print("✅ O'rnatildi: systemd servis '%s' (kompyuter yonganda o'zi ishga tushadi)" % SERVICE)
        print("   Holat: systemctl status %s   |   Log: journalctl -u %s -f" % (SERVICE, SERVICE))
    elif SYSTEM == "Windows":
        startup = os.path.join(os.environ["APPDATA"], r"Microsoft\Windows\Start Menu\Programs\Startup")
        pyw = sys.executable.replace("python.exe", "pythonw.exe")
        if not os.path.exists(pyw):
            pyw = sys.executable
        vbs = os.path.join(startup, "NetAdminMonitor.vbs")
        line = '"%s" %s' % (pyw, " ".join('"%s"' % a for a in cmd_args))
        with open(vbs, "w") as f:
            f.write('CreateObject("WScript.Shell").Run "%s", 0, False\n' % line.replace('"', '""'))
        subprocess.Popen(["wscript", vbs])
        print("✅ O'rnatildi: Windows yonganda yashirin holda o'zi ishga tushadi")
        print("   Fayl: %s" % vbs)
    elif SYSTEM == "Darwin":
        plist = os.path.expanduser("~/Library/LaunchAgents/uz.netadmin.monitor.plist")
        os.makedirs(os.path.dirname(plist), exist_ok=True)
        items = "".join("<string>%s</string>" % a for a in [sys.executable] + cmd_args)
        with open(plist, "w") as f:
            f.write("""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>uz.netadmin.monitor</string>
<key>ProgramArguments</key><array>%s</array>
<key>WorkingDirectory</key><string>%s</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
""" % (items, HERE))
        subprocess.call(["launchctl", "unload", plist], stderr=subprocess.DEVNULL)
        subprocess.call(["launchctl", "load", plist])
        print("✅ O'rnatildi: macOS ga kirganingizda o'zi ishga tushadi (%s)" % plist)
    else:
        sys.exit("Bu OS uchun avtomatik o'rnatish yo'q: %s" % SYSTEM)
    port = args.port
    time.sleep(2)
    print("   Dashboard: http://127.0.0.1:%d" % port)
    if not args.no_browser:
        webbrowser.open("http://127.0.0.1:%d" % port)


def uninstall():
    if SYSTEM == "Linux":
        subprocess.call(["systemctl", "disable", "--now", SERVICE])
        path = "/etc/systemd/system/%s.service" % SERVICE
        if os.path.exists(path):
            os.remove(path)
        subprocess.call(["systemctl", "daemon-reload"])
    elif SYSTEM == "Windows":
        vbs = os.path.join(os.environ["APPDATA"], r"Microsoft\Windows\Start Menu\Programs\Startup\NetAdminMonitor.vbs")
        if os.path.exists(vbs):
            os.remove(vbs)
        subprocess.call(["taskkill", "/F", "/FI", "WINDOWTITLE eq NetAdmin*"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        print("Eslatma: hozir ishlab turgan nusxani Task Manager dan (pythonw.exe) to'xtating.")
    elif SYSTEM == "Darwin":
        plist = os.path.expanduser("~/Library/LaunchAgents/uz.netadmin.monitor.plist")
        subprocess.call(["launchctl", "unload", plist], stderr=subprocess.DEVNULL)
        if os.path.exists(plist):
            os.remove(plist)
    print("Avtomatik ishga tushish o'chirildi. Ma'lumotlar (dashboard/monitor.db) saqlanib qoldi.")


# --------------------------------------------------------------------------- run

def main():
    if sys.version_info < (3, 7):
        sys.exit("Python 3.7 yoki yangisi kerak (sizda %s)" % platform.python_version())
    ap = argparse.ArgumentParser(description="NetAdmin Monitor: dashboard + lokal agent", add_help=True)
    ap.add_argument("--install", action="store_true", help="avtomatik ishga tushadigan qilib o'rnatish")
    ap.add_argument("--uninstall", action="store_true", help="avtomatik ishga tushishni o'chirish")
    ap.add_argument("--no-agent", action="store_true", help="shu kompyuter agentini ishga tushirmaslik")
    ap.add_argument("--no-browser", action="store_true", help="brauzerni ochmaslik")
    ap.add_argument("--agent-port", type=int, default=9800)
    ap.add_argument("--port", type=int, default=8800, help="dashboard porti")
    ap.add_argument("--db", default=os.path.join(HERE, "dashboard", "monitor.db"))
    args, rest = ap.parse_known_args()
    passthrough = ["--port", str(args.port), "--db", args.db] + rest

    if args.uninstall:
        return uninstall()
    if SYSTEM == "Darwin" and hasattr(os, "geteuid") and os.geteuid() == 0:
        sys.exit("macOS'da sudo kerak emas — oddiy holda ishga tushiring:  python3 start.py%s"
                 % (" --install" if args.install else ""))
    if args.install:
        return install(passthrough + ["--agent-port", str(args.agent_port)], args)

    procs = []
    if not args.no_agent and SYSTEM == "Linux":
        token = local_token()
        register_local(args.db, args.agent_port, token)
        procs.append(subprocess.Popen([sys.executable, AGENT, "--token", token, "--port", str(args.agent_port), "--bind", "127.0.0.1"]))
        if os.geteuid() != 0:
            print("ℹ  Agent oddiy foydalanuvchi sifatida ishlayapti: kirish loglari (auth.log) ko'rinmasligi mumkin. "
                  "To'liq ma'lumot uchun: sudo python3 start.py")
    elif not args.no_agent:
        print("ℹ  Agent faqat Linux serverlarda ishlaydi — bu kompyuterda faqat dashboard ishga tushdi.")

    procs.append(subprocess.Popen([sys.executable, DASHBOARD] + passthrough))
    url = "http://127.0.0.1:%d" % args.port
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print("🚀 NetAdmin Monitor: %s   (to'xtatish: Ctrl+C)" % url, flush=True)
    try:
        while True:
            for p in procs:
                if p.poll() is not None:
                    raise SystemExit("Jarayon to'xtadi (kod %s). Yuqoridagi xatoni ko'ring." % p.returncode)
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nTo'xtatilmoqda…")
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()
