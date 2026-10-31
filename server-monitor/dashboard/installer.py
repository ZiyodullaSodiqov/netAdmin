"""
Agentni dashboarddan SSH orqali o'rnatish.

Parol ishlatilmaydi: kompyuterdagi oddiy `ssh` / `scp` buyruqlari va sizning SSH kalitingiz
(~/.ssh/id_ed25519, ssh-agent yoki ko'rsatilgan kalit fayli) ishlatiladi —
xuddi terminalda `ssh root@IP` yozgandek.
"""

import os
import re
import secrets
import shutil
import subprocess
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.join(os.path.dirname(HERE), "agent")

RE_HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:-]*$")
RE_USER = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
RE_ALLOW = re.compile(r"^[0-9A-Fa-f.:,/ ]*$")


class Job:
    def __init__(self, params):
        self.id = secrets.token_hex(6)
        self.params = params
        self.status = "running"
        self.log = []
        self.server_id = None
        self.kind = "install"
        self.started = time.time()
        self.finished = None

    def add(self, line):
        self.log.append(line.rstrip())
        self.log = self.log[-400:]

    def as_dict(self):
        p = self.params
        return {"id": self.id, "kind": self.kind, "status": self.status, "log": self.log, "server_id": self.server_id or p.get("server_id"),
                "host": p["host"], "name": p["name"], "started": self.started, "finished": self.finished}


class Installer:
    def __init__(self, db, monitor):
        self.db = db
        self.mon = monitor
        self.jobs = {}
        self.sem = threading.Semaphore(4)  # bir vaqtda ko'pi bilan 4 ta server

    @staticmethod
    def available():
        return bool(shutil.which("ssh") and shutil.which("scp"))

    def validate(self, body, defaults):
        host = str(body.get("host") or "").strip()
        user = str(body.get("user") or defaults.get("ssh_user") or "root").strip()
        key = os.path.expanduser(str(body.get("key") or defaults.get("ssh_key") or "").strip())
        allow = str(body.get("allow") or "").strip()
        if not RE_HOST.match(host):
            raise ValueError("IP manzil yoki domen noto'g'ri")
        if not RE_USER.match(user):
            raise ValueError("SSH foydalanuvchi nomi noto'g'ri")
        if key and not os.path.isfile(key):
            raise ValueError("SSH kalit fayli topilmadi: %s" % key)
        if not RE_ALLOW.match(allow):
            raise ValueError("--allow qiymati noto'g'ri (IP lar vergul bilan)")
        try:
            ssh_port = int(body.get("ssh_port") or 22)
            agent_port = int(body.get("agent_port") or 9800)
        except (TypeError, ValueError):
            raise ValueError("Port noto'g'ri")
        return {"host": host, "user": user, "key": key, "allow": allow.replace(" ", ""),
                "ssh_port": ssh_port, "agent_port": agent_port,
                "name": str(body.get("name") or "").strip() or host, "group": str(body.get("group") or "").strip()}

    def start(self, params):
        if not self.available():
            raise ValueError("Bu kompyuterda ssh / scp buyruqlari topilmadi")
        job = Job(params)
        self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def _ssh_opts(self, p):
        opts = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12",
                "-o", "ServerAliveInterval=10"]
        if p["key"]:
            opts += ["-i", p["key"], "-o", "IdentitiesOnly=yes"]
        return opts

    def _exec(self, job, cmd, timeout=180):
        shown = " ".join(c if " " not in c else "'%s'" % c for c in cmd)
        job.add("$ " + shown)
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            deadline = time.time() + timeout
            for raw in iter(p.stdout.readline, b""):
                job.add(raw.decode("utf-8", "replace"))
                if time.time() > deadline:
                    p.kill()
                    job.add("… vaqt tugadi (%ds)" % timeout)
                    break
            return p.wait()
        except FileNotFoundError as e:
            job.add(str(e))
            return 127

    def start_geoblock(self, params):
        if not self.available():
            raise ValueError("Bu kompyuterda ssh / scp buyruqlari topilmadi")
        job = Job(params)
        job.kind = "geoblock"
        self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, self._geoblock), daemon=True).start()
        return job

    def _geoblock(self, job):
        """Geo-blokni SSH orqali yoqish/o'chirish. Yoqilgach yangi SSH ulanish ochib tasdiqlaydi —
        ulanib bo'lmasa, tasdiqlanmaydi va server 3 daqiqada o'zi qoidalarni bekor qiladi."""
        p = job.params
        target = "%s@%s" % (p["user"], p["host"])
        opts = self._ssh_opts(p)
        ssh = ["ssh"] + opts + ["-p", str(p["ssh_port"]), target]
        sudo = "" if p["user"] == "root" else "sudo -n "

        if p["action"] == "disable":
            job.add("Geo-blok o'chirilmoqda…")
            rc = self._exec(job, ssh + ["%s/usr/local/sbin/netadmin-geoblock disable || echo \"geo-blok o'rnatilmagan\"" % sudo], timeout=60)
            job.status = "ok" if rc == 0 else "error"
            if rc == 0:
                self.mon.event(p.get("server_id"), "info", "geoblock", "%s: geo-blok o'chirildi" % p["name"])
                self.mon.poll_now(p.get("server_id"))
            return

        job.add("1/4 Serverga ulanish tekshirilmoqda…")
        if self._exec(job, ssh + ["echo ulanish-ok"], timeout=40) != 0:
            job.add("Ulanib bo'lmadi — `ssh %s` parolsiz ishlashini tekshiring." % target)
            job.status = "error"
            return
        job.add("2/4 Skript yuborilmoqda…")
        remote = "/tmp/netadmin-geo-%s" % job.id
        if self._exec(job, ssh + ["mkdir -p %s" % remote], timeout=30) != 0 or \
                self._exec(job, ["scp"] + opts + ["-P", str(p["ssh_port"]), os.path.join(AGENT_DIR, "geoblock.sh"), "%s:%s/" % (target, remote)], timeout=60) != 0:
            job.status = "error"
            return
        job.add("3/4 Qoidalar o'rnatilmoqda (O'zbekiston IP ro'yxati RIPE dan yuklanadi)…")
        mode = "--all" if p["mode"] == "all" else "--ports %s" % p["ports"]
        cmd = ('CIP="${SSH_CLIENT%%%% *}"; %sbash %s/geoblock.sh enable %s --country %s --allow "$CIP,%s" --confirm 180; '
               'rc=$?; rm -rf %s; exit $rc') % (sudo, remote, mode, p["country"], p["allow"], remote)
        if self._exec(job, ssh + [cmd], timeout=300) != 0:
            job.status = "error"
            return
        time.sleep(3)
        job.add("4/4 Yangi SSH ulanish bilan tekshirilmoqda…")
        if self._exec(job, ssh + ["%s/usr/local/sbin/netadmin-geoblock confirm" % sudo], timeout=40) != 0:
            job.add("⚠ Yangi ulanish ochilmadi — qoidalar TASDIQLANMADI va 3 daqiqada avtomatik bekor qilinadi.")
            job.status = "error"
            return
        self.mon.event(p.get("server_id"), "info", "geoblock", "%s: geo-blok yoqildi (faqat %s)" % (p["name"], p["country"]))
        self.mon.poll_now(p.get("server_id"))
        job.add("✅ Geo-blok yoqildi va tasdiqlandi.")
        job.status = "ok"

    def _run(self, job, fn=None):
        with self.sem:
            try:
                (fn or self._install)(job)
            except Exception as e:
                job.add("Xato: %s" % e)
                job.status = "error"
            job.finished = time.time()

    def _install(self, job):
        p = job.params
        target = "%s@%s" % (p["user"], p["host"])
        opts = self._ssh_opts(p)
        ssh = ["ssh"] + opts + ["-p", str(p["ssh_port"]), target]
        sudo = "" if p["user"] == "root" else "sudo -n "

        job.add("1/4 Serverga ulanish tekshirilmoqda…")
        if self._exec(job, ssh + ["echo ulanish-ok && uname -sr && command -v python3"], timeout=40) != 0:
            job.add("")
            job.add("Ulanib bo'lmadi. Tekshiring:")
            job.add("  • terminalda `ssh %s` parol so'ramasdan kiradimi?" % target)
            job.add("  • kalit boshqa joyda bo'lsa, 'SSH kalit fayli' maydoniga yo'lini yozing (masalan ~/.ssh/do_key)")
            job.add("  • serverda python3 o'rnatilganmi")
            job.status = "error"
            return

        job.add("2/4 Agent fayllari yuborilmoqda…")
        remote = "/tmp/netadmin-install-%s" % job.id
        if self._exec(job, ssh + ["mkdir -p %s" % remote], timeout=30) != 0:
            job.status = "error"
            return
        files = [os.path.join(AGENT_DIR, "netadmin_agent.py"), os.path.join(AGENT_DIR, "install.sh")]
        if self._exec(job, ["scp"] + opts + ["-P", str(p["ssh_port"])] + files + ["%s:%s/" % (target, remote)], timeout=120) != 0:
            job.status = "error"
            return

        job.add("3/4 Agent o'rnatilmoqda…")
        token = secrets.token_hex(24)
        cmd = "%sbash %s/install.sh --token %s --port %d" % (sudo, remote, token, p["agent_port"])
        if p["allow"]:
            cmd += " --allow %s" % p["allow"]
        cmd += "; rc=$?; rm -rf %s; exit $rc" % remote
        if self._exec(job, ssh + [cmd], timeout=240) != 0:
            if sudo:
                job.add("Eslatma: root bo'lmagan foydalanuvchi uchun parolsiz sudo (NOPASSWD) kerak.")
            job.status = "error"
            return

        job.add("4/4 Dashboardga qo'shilmoqda…")
        existing = self.db.q("SELECT id FROM servers WHERE host=? AND port=?", (p["host"], p["agent_port"]), one=True)
        if existing:
            self.db.x("UPDATE servers SET token=? WHERE id=?", (token, existing["id"]))
            sid = existing["id"]
            job.add("Server avval qo'shilgan edi — token yangilandi.")
        else:
            sid = self.db.x("INSERT INTO servers(name, host, port, token, grp, notes, created) VALUES (?,?,?,?,?,?,?)",
                            (p["name"], p["host"], p["agent_port"], token, p["group"], "SSH orqali o'rnatilgan", time.time()))
            self.mon.event(sid, "info", "server", "Server qo'shildi (SSH orqali): %s (%s)" % (p["name"], p["host"]))
        job.server_id = sid
        self.mon.poll_now(sid)
        job.add("✅ Tayyor! Bir necha soniyada ma'lumotlar ko'rinadi.")
        job.status = "ok"
