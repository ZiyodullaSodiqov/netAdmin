#!/usr/bin/env python3
"""
NetAdmin Agent — har bir Linux serverga o'rnatiladigan yengil monitoring agenti.

Faqat Python 3.6+ standart kutubxonasi ishlatiladi (pip kerak emas).
Ma'lumotlar /proc, /sys, utmp/wtmp va log fayllardan o'qiladi va
token bilan himoyalangan HTTP JSON ko'rinishida beriladi:

    GET /metrics      (sarlavha: Authorization: Bearer <token>)
    GET /health

Sozlash (argument yoki muhit o'zgaruvchisi):
    --token / NETADMIN_TOKEN            majburiy
    --port  / NETADMIN_PORT             standart 9800
    --bind  / NETADMIN_BIND             standart 0.0.0.0
    --allow / NETADMIN_ALLOW            ruxsat etilgan IP lar, vergul bilan (bo'sh = hammasi)
    --access-log / NETADMIN_ACCESS_LOGS nginx/apache access log yo'llari, vergul bilan
"""

import argparse
import calendar
import glob
import hmac
import json
import os
import platform
import pwd
import re
import socket
import struct
import subprocess
import threading
import time
from collections import Counter, deque
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

VERSION = "1.0.0"

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096

DEFAULT_ACCESS_LOGS = [
    "/var/log/nginx/access.log",
    "/var/log/apache2/access.log",
    "/var/log/httpd/access_log",
    "/var/log/caddy/access.log",
]
AUTH_LOGS = ["/var/log/auth.log", "/var/log/secure"]

REAL_FS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3",
    "f2fs", "jfs", "reiserfs", "fuseblk", "nfs", "nfs4", "cifs", "smbfs", "bcachefs",
}


# --------------------------------------------------------------------------- utils

def read_file(path, default=""):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read()
    except (IOError, OSError):
        return default


def tail_bytes(path, size):
    """Faylning oxirgi `size` baytini qatorlar ro'yxati sifatida qaytaradi."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            start = max(0, end - size)
            f.seek(start)
            data = f.read()
    except (IOError, OSError):
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # birinchi qator chala bo'lishi mumkin
    return lines


def run(cmd, timeout=5):
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        out, _ = p.communicate(timeout=timeout)
        return out.decode("utf-8", "replace")
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
        return ""


_uid_cache = {}


def uid_name(uid):
    if uid not in _uid_cache:
        try:
            _uid_cache[uid] = pwd.getpwuid(uid).pw_name
        except KeyError:
            _uid_cache[uid] = str(uid)
    return _uid_cache[uid]


# --------------------------------------------------------------------------- static info

def os_name():
    data = read_file("/etc/os-release")
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', data, re.M)
    return m.group(1) if m else platform.system()


def cpu_model():
    data = read_file("/proc/cpuinfo")
    m = re.search(r"^(model name|Hardware|Processor)\s*:\s*(.+)$", data, re.M)
    return m.group(2).strip() if m else platform.processor()


def primary_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # paket yuborilmaydi, faqat marshrut tanlanadi
        return s.getsockname()[0]
    except Exception:
        return ""
    finally:
        s.close()


# --------------------------------------------------------------------------- sampler

class Sampler(threading.Thread):
    """Fonda ishlab, CPU/disk/tarmoq/jarayon tezliklarini (delta) hisoblaydi."""

    def __init__(self, interval=2.0):
        threading.Thread.__init__(self, daemon=True)
        self.interval = interval
        self.lock = threading.Lock()
        self.cpu = {"total": 0.0, "user": 0.0, "system": 0.0, "iowait": 0.0, "steal": 0.0, "cores": []}
        self.net = {}
        self.disk_io = {}
        self.procs = []
        self.proc_count = 0
        self.threads = 0
        self._prev_cpu = None
        self._prev_net = None
        self._prev_disk = None
        self._prev_proc = {}
        self._prev_proc_t = None
        self._tick = 0

    # -- CPU
    @staticmethod
    def _read_cpu():
        res = {}
        for line in read_file("/proc/stat").splitlines():
            if not line.startswith("cpu"):
                continue
            parts = line.split()
            vals = [int(x) for x in parts[1:9]] + [0] * max(0, 8 - len(parts[1:9]))
            res[parts[0]] = vals
        return res

    def _calc_cpu(self, cur):
        prev = self._prev_cpu
        self._prev_cpu = cur
        if not prev:
            return None
        out = {}
        for name, v in cur.items():
            p = prev.get(name)
            if not p:
                continue
            d = [a - b for a, b in zip(v, p)]
            total = sum(d) or 1
            user, nice, system, idle, iowait, irq, softirq, steal = d
            out[name] = {
                "total": round(100.0 * (total - idle - iowait) / total, 1),
                "user": round(100.0 * (user + nice) / total, 1),
                "system": round(100.0 * (system + irq + softirq) / total, 1),
                "iowait": round(100.0 * iowait / total, 1),
                "steal": round(100.0 * steal / total, 1),
            }
        return out

    # -- network
    @staticmethod
    def _read_net():
        res = {}
        for line in read_file("/proc/net/dev").splitlines()[2:]:
            if ":" not in line:
                continue
            name, data = line.split(":", 1)
            name = name.strip()
            f = data.split()
            if name == "lo" or len(f) < 16:
                continue
            res[name] = (int(f[0]), int(f[8]), int(f[1]), int(f[9]), int(f[2]) + int(f[10]), int(f[3]) + int(f[11]))
        return res

    # -- disk io
    @staticmethod
    def _read_disk():
        res = {}
        for line in read_file("/proc/diskstats").splitlines():
            f = line.split()
            if len(f) < 14:
                continue
            name = f[2]
            if name.startswith(("loop", "ram", "zram", "fd", "sr")):
                continue
            if not os.path.exists("/sys/block/%s" % name.replace("/", "!")):
                continue  # bo'lim (partition) — faqat butun disklar
            res[name] = (int(f[3]), int(f[5]) * 512, int(f[7]), int(f[9]) * 512, int(f[12]))
        return res

    # -- processes
    def _read_procs(self, dt):
        procs = []
        cur = {}
        threads = 0
        total_mem = mem_total_bytes() or 1
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            stat = read_file("/proc/%s/stat" % pid)
            if not stat:
                continue
            try:
                r = stat.rindex(")")
                comm = stat[stat.index("(") + 1:r]
                f = stat[r + 2:].split()
                ticks = int(f[11]) + int(f[12])
                nthreads = int(f[17])
                rss = int(f[21]) * PAGE_SIZE
                state = f[0]
                uid = os.stat("/proc/%s" % pid).st_uid
            except (ValueError, IndexError, OSError):
                continue
            threads += nthreads
            cur[pid] = ticks
            prev = self._prev_proc.get(pid)
            cpu = 0.0
            if prev is not None and dt:
                cpu = 100.0 * (ticks - prev) / CLK_TCK / dt
            procs.append((pid, comm, cpu, rss, uid, state, nthreads))
        self._prev_proc = cur
        procs_cpu = sorted(procs, key=lambda p: p[2], reverse=True)[:15]
        procs_mem = sorted(procs, key=lambda p: p[3], reverse=True)[:15]
        seen = set()
        top = []
        for p in procs_cpu + procs_mem:
            if p[0] in seen:
                continue
            seen.add(p[0])
            cmd = read_file("/proc/%s/cmdline" % p[0]).replace("\x00", " ").strip()
            top.append({
                "pid": int(p[0]), "name": p[1], "cmd": cmd[:200] or "[%s]" % p[1],
                "cpu": round(p[2], 1), "mem": p[3], "mem_pct": round(100.0 * p[3] / total_mem, 1),
                "user": uid_name(p[4]), "state": p[5], "threads": p[6],
            })
        return top, len(procs), threads

    def run(self):
        while True:
            try:
                self.sample()
            except Exception:
                pass
            time.sleep(self.interval)

    def sample(self):
        now = time.time()
        cpu = self._calc_cpu(self._read_cpu())
        net_cur = self._read_net()
        disk_cur = self._read_disk()
        net = {}
        disk = {}
        if self._prev_net:
            t0, prev = self._prev_net
            dt = (now - t0) or 1
            for n, v in net_cur.items():
                p = prev.get(n)
                if p:
                    net[n] = {
                        "rx": max(0, (v[0] - p[0]) / dt), "tx": max(0, (v[1] - p[1]) / dt),
                        "rx_pkt": max(0, (v[2] - p[2]) / dt), "tx_pkt": max(0, (v[3] - p[3]) / dt),
                        "errors": v[4], "drops": v[5],
                        "rx_total": v[0], "tx_total": v[1],
                    }
        if self._prev_disk:
            t0, prev = self._prev_disk
            dt = (now - t0) or 1
            for n, v in disk_cur.items():
                p = prev.get(n)
                if p:
                    disk[n] = {
                        "read_iops": max(0, (v[0] - p[0]) / dt), "read": max(0, (v[1] - p[1]) / dt),
                        "write_iops": max(0, (v[2] - p[2]) / dt), "write": max(0, (v[3] - p[3]) / dt),
                        "util": min(100.0, max(0, (v[4] - p[4]) / dt / 10.0)),
                    }
        self._prev_net = (now, net_cur)
        self._prev_disk = (now, disk_cur)

        procs = None
        if self._tick % 3 == 0:  # jarayonlarni har ~6 sekundda skanerlash
            dt = (now - self._prev_proc_t) if self._prev_proc_t else 0
            procs = self._read_procs(dt)
            self._prev_proc_t = now
        self._tick += 1

        with self.lock:
            if cpu:
                total = cpu.get("cpu", {})
                cores = [cpu[k]["total"] for k in sorted((k for k in cpu if k != "cpu"), key=lambda k: int(k[3:]))]
                self.cpu = dict(total, cores=cores)
            if self._prev_net and net:
                self.net = net
            if disk:
                self.disk_io = disk
            if procs:
                self.procs, self.proc_count, self.threads = procs

    def snapshot(self):
        with self.lock:
            return {
                "cpu": dict(self.cpu), "net": dict(self.net), "disk_io": dict(self.disk_io),
                "procs": list(self.procs), "proc_count": self.proc_count, "threads": self.threads,
            }


# --------------------------------------------------------------------------- memory / disk

def meminfo():
    res = {}
    for line in read_file("/proc/meminfo").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            res[parts[0].rstrip(":")] = int(parts[1]) * 1024
    return res


def mem_total_bytes():
    return meminfo().get("MemTotal", 0)


def memory():
    m = meminfo()
    total = m.get("MemTotal", 0)
    avail = m.get("MemAvailable", m.get("MemFree", 0) + m.get("Buffers", 0) + m.get("Cached", 0))
    used = total - avail
    swap_total = m.get("SwapTotal", 0)
    swap_used = swap_total - m.get("SwapFree", 0)
    return {
        "total": total, "used": used, "available": avail, "free": m.get("MemFree", 0),
        "buffers": m.get("Buffers", 0), "cached": m.get("Cached", 0) + m.get("SReclaimable", 0),
        "percent": round(100.0 * used / total, 1) if total else 0,
        "swap_total": swap_total, "swap_used": swap_used,
        "swap_percent": round(100.0 * swap_used / swap_total, 1) if swap_total else 0,
    }


def disks():
    res = []
    seen = set()
    for line in read_file("/proc/mounts").splitlines():
        f = line.split()
        if len(f) < 3:
            continue
        dev, mnt, fstype = f[0], f[1].replace("\\040", " "), f[2]
        if fstype not in REAL_FS or dev in seen:
            continue
        if mnt.startswith(("/snap/", "/var/lib/docker/", "/run/")):
            continue
        seen.add(dev)
        try:
            st = os.statvfs(mnt)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total == 0:
            continue
        free = st.f_bavail * st.f_frsize
        used = total - st.f_bfree * st.f_frsize
        res.append({
            "device": dev, "mount": mnt, "fstype": fstype, "total": total, "used": used, "free": free,
            "percent": round(100.0 * used / (used + free), 1) if used + free else 0,
            "inodes_percent": round(100.0 * (st.f_files - st.f_ffree) / st.f_files, 1) if st.f_files else 0,
        })
    return res


def temperatures():
    res = []
    for zone in glob.glob("/sys/class/thermal/thermal_zone*"):
        t = read_file(zone + "/temp").strip()
        if t.lstrip("-").isdigit():
            res.append({"name": read_file(zone + "/type").strip() or os.path.basename(zone), "c": int(t) / 1000.0})
    for hw in glob.glob("/sys/class/hwmon/hwmon*"):
        name = read_file(hw + "/name").strip()
        for inp in glob.glob(hw + "/temp*_input"):
            t = read_file(inp).strip()
            if t.lstrip("-").isdigit():
                label = read_file(inp.replace("_input", "_label")).strip()
                res.append({"name": "%s %s" % (name, label) if label else name, "c": int(t) / 1000.0})
    return [t for t in res if -30 < t["c"] < 150]


# --------------------------------------------------------------------------- network sockets

TCP_STATES = {
    "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1", "05": "FIN_WAIT2",
    "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING",
}


def _hex_ip(h):
    if len(h) == 8:
        return socket.inet_ntop(socket.AF_INET, struct.pack("<I", int(h, 16)))
    b = b"".join(struct.pack("<I", int(h[i:i + 8], 16)) for i in range(0, 32, 8))
    ip = socket.inet_ntop(socket.AF_INET6, b)
    return ip[7:] if ip.startswith("::ffff:") else ip


_listen_cache = {"t": 0, "data": []}


def sockets():
    states = Counter()
    listen = {}
    remote = Counter()
    for proto, path in (("tcp", "/proc/net/tcp"), ("tcp", "/proc/net/tcp6"), ("udp", "/proc/net/udp"), ("udp", "/proc/net/udp6")):
        for line in read_file(path).splitlines()[1:]:
            f = line.split()
            if len(f) < 10:
                continue
            st = f[3]
            if proto == "tcp":
                states[TCP_STATES.get(st, st)] += 1
            is_listen = (proto == "tcp" and st == "0A") or (proto == "udp" and st == "07" and f[2].endswith(":0000"))
            lip, lport = f[1].rsplit(":", 1)
            if is_listen:
                port = int(lport, 16)
                key = (proto, port)
                if key not in listen:
                    listen[key] = {"proto": proto, "port": port, "addr": _hex_ip(lip), "inode": f[9]}
            elif proto == "tcp" and st == "01":
                rip, _ = f[2].rsplit(":", 1)
                ip = _hex_ip(rip)
                if not ip.startswith("127.") and ip != "::1":
                    remote[ip] += 1
    # jarayon nomlarini topish (har 30 sekundda)
    now = time.time()
    if now - _listen_cache["t"] > 30:
        inode_map = {}
        wanted = set(v["inode"] for v in listen.values())
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                for fd in os.listdir("/proc/%s/fd" % pid):
                    try:
                        link = os.readlink("/proc/%s/fd/%s" % (pid, fd))
                    except OSError:
                        continue
                    if link.startswith("socket:["):
                        ino = link[8:-1]
                        if ino in wanted and ino not in inode_map:
                            inode_map[ino] = (int(pid), read_file("/proc/%s/comm" % pid).strip())
            except OSError:
                continue
        _listen_cache["t"] = now
        _listen_cache["data"] = inode_map
    inode_map = _listen_cache["data"]
    ports = []
    for v in sorted(listen.values(), key=lambda x: (x["proto"], x["port"])):
        pid, name = inode_map.get(v["inode"], (None, ""))
        ports.append({"proto": v["proto"], "port": v["port"], "addr": v["addr"], "pid": pid, "process": name})
    return {
        "tcp_states": dict(states),
        "established": states.get("ESTABLISHED", 0),
        "listening": ports,
        "top_remote": [{"ip": ip, "count": c} for ip, c in remote.most_common(15)],
    }


# --------------------------------------------------------------------------- logins

UTMP_FMT = "<hhi32s4s32s256shhiii4i20s"
UTMP_SIZE = struct.calcsize(UTMP_FMT)  # 384


def _cstr(b):
    return b.split(b"\x00", 1)[0].decode("utf-8", "replace")


def parse_utmp(path, max_records=None):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if max_records:
                start = max(0, size - max_records * UTMP_SIZE)
                start -= start % UTMP_SIZE
                f.seek(start)
            data = f.read()
    except (IOError, OSError):
        return []
    out = []
    for i in range(0, len(data) - UTMP_SIZE + 1, UTMP_SIZE):
        r = struct.unpack(UTMP_FMT, data[i:i + UTMP_SIZE])
        out.append({
            "type": r[0], "pid": r[2], "line": _cstr(r[3]), "user": _cstr(r[5]),
            "host": _cstr(r[6]), "ts": r[10] + r[11] / 1e6,
        })
    return out


def current_users():
    res = []
    for r in parse_utmp("/var/run/utmp") or parse_utmp("/run/utmp"):
        if r["type"] == 7 and r["user"] and os.path.exists("/proc/%d" % r["pid"]):
            res.append({"user": r["user"], "tty": r["line"], "from": r["host"] or "lokal", "since": r["ts"]})
    if not res:  # utmp bo'lmasa (masalan, yangi distributivlar) — `who`
        for line in run(["who", "--ips"]).splitlines() or run(["who"]).splitlines():
            f = line.split()
            if len(f) >= 2:
                host = f[-1].strip("()") if len(f) >= 5 else "lokal"
                res.append({"user": f[0], "tty": f[1], "from": host, "since": None})
    return res


def login_history(limit=50):
    """wtmp dan oxirgi kirishlar (kim, qayerdan, qachon, qancha vaqt)."""
    records = parse_utmp("/var/log/wtmp", max_records=4000)
    sessions = []
    open_by_line = {}
    for r in records:
        if r["type"] == 7 and r["user"]:
            s = {"user": r["user"], "tty": r["line"], "from": r["host"] or "lokal", "login": r["ts"], "logout": None, "active": True}
            sessions.append(s)
            open_by_line[r["line"]] = s
        elif r["type"] == 8:
            s = open_by_line.pop(r["line"], None)
            if s:
                s["logout"] = r["ts"]
                s["active"] = False
        elif r["type"] in (1, 2):  # reboot / shutdown — ochiq seanslar yopiladi
            for s in open_by_line.values():
                s["logout"] = r["ts"]
                s["active"] = False
            open_by_line.clear()
            if r["type"] == 2:
                sessions.append({"user": "reboot", "tty": "system boot", "from": r["host"], "login": r["ts"], "logout": None, "active": False})
    if not sessions:  # wtmpdb ishlatadigan tizimlar
        for line in run(["last", "-F", "-w", "-i", "-n", str(limit)]).splitlines():
            f = line.split()
            if len(f) >= 3 and f[0] not in ("wtmp", "wtmpdb") and not line.startswith("wtmp"):
                sessions.append({"user": f[0], "tty": f[1], "from": f[2], "login": None, "logout": None,
                                 "active": "still logged in" in line, "raw": line.strip()})
        return sessions[:limit]
    return list(reversed(sessions))[:limit]


MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
RE_SYSLOG_TS = re.compile(r"^([A-Z][a-z]{2})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)\s")
RE_ISO_TS = re.compile(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?([+-]\d\d:?\d\d|Z)?\s")
RE_ACCEPT = re.compile(r"sshd\[\d+\]: Accepted (\S+) for (\S+) from (\S+) port (\d+)")
RE_FAILED = re.compile(r"sshd\[\d+\]: Failed (\S+) for (?:invalid user )?(\S+) from (\S+) port (\d+)")
RE_INVALID = re.compile(r"sshd\[\d+\]: Invalid user (\S*) from ([0-9a-fA-F.:]+)")
RE_SUDO = re.compile(r"sudo(?:\[\d+\])?:\s+(\S+) : .*COMMAND=(.+)$")


def _log_ts(line):
    m = RE_ISO_TS.match(line)
    if m:
        y, mo, d, h, mi, s, tz = m.groups()
        tt = (int(y), int(mo), int(d), int(h), int(mi), int(s), 0, 0, -1)
        if not tz:
            return time.mktime(tt)
        off = 0
        if tz != "Z":
            tzs = tz.replace(":", "")
            off = (int(tzs[1:3]) * 3600 + int(tzs[3:5]) * 60) * (1 if tzs[0] == "+" else -1)
        return calendar.timegm(tt) - off
    m = RE_SYSLOG_TS.match(line)
    if m:
        mon, d, h, mi, s = m.groups()
        now = time.localtime()
        year = now.tm_year
        if MONTHS.get(mon, 1) > now.tm_mon:
            year -= 1
        return time.mktime((year, MONTHS.get(mon, 1), int(d), int(h), int(mi), int(s), 0, 0, -1))
    return None


_auth_cache = {"t": 0, "data": None}


def auth_events():
    now = time.time()
    if _auth_cache["data"] is not None and now - _auth_cache["t"] < 15:
        return _auth_cache["data"]
    lines = []
    for p in AUTH_LOGS:
        if os.path.exists(p):
            lines = tail_bytes(p, 1024 * 1024)
            break
    if not lines:
        lines = run(["journalctl", "-o", "short-iso", "--no-pager", "-n", "5000", "--since", "-48h",
                     "_COMM=sshd", "+", "_COMM=sudo", "+", "SYSLOG_IDENTIFIER=sshd"], timeout=8).splitlines()
    accepted, failed, sudo = deque(maxlen=60), deque(maxlen=100), deque(maxlen=40)
    failed_ips, failed_users = Counter(), Counter()
    failed_24h = 0
    last_invalid = None
    for line in lines:
        m = RE_ACCEPT.search(line)
        if m:
            accepted.append({"ts": _log_ts(line), "method": m.group(1), "user": m.group(2), "ip": m.group(3), "port": int(m.group(4))})
            continue
        m = RE_FAILED.search(line)
        ip = user = None
        from_invalid = False
        if m:
            user, ip = m.group(2), m.group(3)
            # sshd avval "Invalid user X from IP" yozadi — o'sha urinishni ikki marta sanamaymiz
            if last_invalid == (user, ip):
                last_invalid = None
                continue
        else:
            m = RE_INVALID.search(line)
            if m:
                user, ip = m.group(1) or "?", m.group(2)
                from_invalid = True
        last_invalid = (user, ip) if from_invalid else None
        if ip:
            ts = _log_ts(line)
            failed.append({"ts": ts, "user": user, "ip": ip})
            if ts is None or now - ts < 86400:
                failed_ips[ip] += 1
                failed_users[user] += 1
                failed_24h += 1
            continue
        m = RE_SUDO.search(line)
        if m:
            sudo.append({"ts": _log_ts(line), "user": m.group(1), "command": m.group(2).strip()[:200]})
    data = {
        "accepted": list(reversed(accepted)),
        "failed": list(reversed(failed)),
        "sudo": list(reversed(sudo)),
        "failed_24h": failed_24h,
        "top_failed_ips": [{"ip": k, "count": v} for k, v in failed_ips.most_common(15)],
        "top_failed_users": [{"user": k, "count": v} for k, v in failed_users.most_common(10)],
    }
    _auth_cache["t"] = now
    _auth_cache["data"] = data
    return data


# --------------------------------------------------------------------------- HTTP access logs

RE_ACCESS = re.compile(
    r'^(?:(?P<vhost>\S+) )?(?P<ip>[0-9a-fA-F.:]+) \S+ (?P<user>\S+) \[(?P<time>[^\]]+)\] '
    r'"(?P<method>[A-Z]+) (?P<path>\S+)[^"]*" (?P<status>\d{3}) (?P<bytes>\S+)'
    r'(?: "(?P<ref>[^"]*)" "(?P<ua>[^"]*)")?(?P<rest>.*)$'
)


def _access_ts(s):
    # 22/Oct/2026:10:15:32 +0500
    try:
        dt, tz = s.split(" ") if " " in s else (s, "+0000")
        d, mon, rest = dt.split("/")
        y, h, mi, sec = rest.split(":")
        t = calendar.timegm((int(y), MONTHS.get(mon, 1), int(d), int(h), int(mi), int(sec), 0, 0, 0))
        off = (int(tz[1:3]) * 3600 + int(tz[3:5]) * 60) * (1 if tz[0] == "+" else -1)
        return t - off
    except Exception:
        return None


_access_cache = {"t": 0, "data": None}


def access_logs(paths):
    now = time.time()
    if _access_cache["data"] is not None and now - _access_cache["t"] < 5:
        return _access_cache["data"]
    files = []
    for p in paths:
        files.extend(sorted(glob.glob(p)) if any(c in p for c in "*?[") else ([p] if os.path.exists(p) else []))
    entries = []
    for path in files:
        for line in tail_bytes(path, 512 * 1024):
            m = RE_ACCESS.match(line)
            if not m:
                continue
            ts = _access_ts(m.group("time"))
            rest = (m.group("rest") or "").strip().split()
            rt = None
            if rest:
                try:
                    rt = float(rest[-1])  # $request_time (ixtiyoriy)
                except ValueError:
                    pass
            entries.append({
                "ts": ts, "ip": m.group("ip"), "method": m.group("method"), "path": m.group("path")[:300],
                "status": int(m.group("status")), "bytes": int(m.group("bytes")) if m.group("bytes").isdigit() else 0,
                "ua": (m.group("ua") or "")[:160], "rt": rt, "log": os.path.basename(path),
            })
    entries.sort(key=lambda e: e["ts"] or 0)
    last_5m = [e for e in entries if e["ts"] and now - e["ts"] < 300]
    last_1h = [e for e in entries if e["ts"] and now - e["ts"] < 3600]
    window = last_1h or entries
    status = Counter()
    endpoints = Counter()
    ips = Counter()
    errors = Counter()
    for e in window:
        status["%dxx" % (e["status"] // 100)] += 1
        ep = "%s %s" % (e["method"], e["path"].split("?", 1)[0])
        endpoints[ep] += 1
        ips[e["ip"]] += 1
        if e["status"] >= 500:
            errors[ep] += 1
    rts = sorted(e["rt"] for e in last_5m if e["rt"] is not None)
    data = {
        "files": files,
        "recent": list(reversed(entries[-150:])),
        "rpm": round(len(last_5m) / 5.0, 1),
        "requests_1h": len(last_1h),
        "status": dict(status),
        "top_endpoints": [{"endpoint": k, "count": v} for k, v in endpoints.most_common(20)],
        "top_ips": [{"ip": k, "count": v} for k, v in ips.most_common(15)],
        "top_errors": [{"endpoint": k, "count": v} for k, v in errors.most_common(10)],
        "p95_ms": round(rts[int(len(rts) * 0.95) - 1] * 1000, 1) if rts else None,
        "window": "1h" if last_1h else "tail",
    }
    _access_cache["t"] = now
    _access_cache["data"] = data
    return data


# --------------------------------------------------------------------------- services

_svc_cache = {"t": 0, "data": None}


def services():
    now = time.time()
    if _svc_cache["data"] is not None and now - _svc_cache["t"] < 60:
        return _svc_cache["data"]
    failed = []
    for line in run(["systemctl", "list-units", "--state=failed", "--no-legend", "--plain", "--no-pager"]).splitlines():
        f = line.split()
        if f:
            failed.append(f[0])
    running = len(run(["systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain", "--no-pager"]).splitlines())
    data = {"failed": failed, "running": running}
    _svc_cache["t"] = now
    _svc_cache["data"] = data
    return data


# --------------------------------------------------------------------------- collect

def collect(sampler, access_paths):
    s = sampler.snapshot()
    load = os.getloadavg()
    uptime = float(read_file("/proc/uptime", "0").split()[0] or 0)
    cores = os.cpu_count() or 1
    net_total = {"rx": sum(v["rx"] for v in s["net"].values()), "tx": sum(v["tx"] for v in s["net"].values())}
    disk_total = {"read": sum(v["read"] for v in s["disk_io"].values()), "write": sum(v["write"] for v in s["disk_io"].values())}
    data = {
        "agent_version": VERSION,
        "time": time.time(),
        "host": {
            "hostname": socket.gethostname(), "os": os_name(), "kernel": platform.release(),
            "arch": platform.machine(), "cpu_model": cpu_model(), "cores": cores,
            "uptime": uptime, "boot_time": time.time() - uptime, "ip": primary_ip(),
            "virtualization": read_file("/sys/class/dmi/id/product_name").strip(),
        },
        "cpu": s["cpu"],
        "load": {"1": load[0], "5": load[1], "15": load[2], "per_core": round(load[0] / cores, 2)},
        "memory": memory(),
        "disks": disks(),
        "disk_io": s["disk_io"], "disk_io_total": disk_total,
        "net": s["net"], "net_total": net_total,
        "processes": {"count": s["proc_count"], "threads": s["threads"], "top": s["procs"]},
        "temps": temperatures(),
    }
    for key, fn in (("sockets", sockets), ("users", current_users), ("logins", login_history),
                    ("auth", auth_events), ("services", services)):
        try:
            data[key] = fn()
        except Exception as e:
            data[key] = {"error": str(e)}
    try:
        data["http"] = access_logs(access_paths)
    except Exception as e:
        data["http"] = {"error": str(e)}
    return data


# --------------------------------------------------------------------------- HTTP server

class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_handler(token, allow, sampler, access_paths):
    class Handler(BaseHTTPRequestHandler):
        server_version = "NetAdminAgent/" + VERSION

        def log_message(self, *args):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if allow and self.client_address[0] not in allow:
                return self._send(403, {"error": "ip not allowed"})
            path = self.path.split("?", 1)[0]
            if path == "/health":
                return self._send(200, {"ok": True, "version": VERSION})
            if path != "/metrics":
                return self._send(404, {"error": "not found"})
            got = self.headers.get("Authorization", "")
            got = got[7:] if got.startswith("Bearer ") else self.headers.get("X-Token", "")
            if not hmac.compare_digest(got.encode(), token.encode()):
                return self._send(401, {"error": "bad token"})
            try:
                self._send(200, collect(sampler, access_paths))
            except Exception as e:
                self._send(500, {"error": str(e)})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="NetAdmin monitoring agent")
    ap.add_argument("--token", default=os.environ.get("NETADMIN_TOKEN", ""))
    ap.add_argument("--port", type=int, default=int(os.environ.get("NETADMIN_PORT", "9800")))
    ap.add_argument("--bind", default=os.environ.get("NETADMIN_BIND", "0.0.0.0"))
    ap.add_argument("--allow", default=os.environ.get("NETADMIN_ALLOW", ""))
    ap.add_argument("--access-log", default=os.environ.get("NETADMIN_ACCESS_LOGS", ""))
    ap.add_argument("--once", action="store_true", help="bir marta yig'ib JSON chiqarish (test uchun)")
    args = ap.parse_args()

    access_paths = [p.strip() for p in args.access_log.split(",") if p.strip()] or DEFAULT_ACCESS_LOGS
    sampler = Sampler()
    if args.once:
        sampler.sample()
        time.sleep(1)
        sampler.sample()
        print(json.dumps(collect(sampler, access_paths), indent=2, default=str))
        return
    if not args.token:
        ap.error("--token (yoki NETADMIN_TOKEN) majburiy")
    sampler.sample()
    sampler.start()
    allow = set(a.strip() for a in args.allow.split(",") if a.strip())
    srv = Server((args.bind, args.port), make_handler(args.token, allow, sampler, access_paths))
    print("NetAdmin agent %s :%d da ishlayapti" % (VERSION, args.port), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
