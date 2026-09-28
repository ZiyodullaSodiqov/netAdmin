// IP telefon paneli: displey, raqam terish, qo'ng'iroq holati, ovoz sifati (MOS, jitter, yo'qotish).
import { useState } from 'react';
import { store, useStore } from '../store';
import type { IpPhone } from '../../engine/devices/ipphone';

const STATE_TEXT: Record<string, string> = {
  idle: '',
  offhook: 'Terilmoqda...',
  ringout: "Chaqiruv ketmoqda (qo'ng'iroq)...",
  ringing: "📞 Kiruvchi qo'ng'iroq!",
  connected: '🔊 Suhbat',
  busy: 'Band',
  unknown: "Noma'lum raqam",
};

export function PhoneTab({ device }: { device: IpPhone }) {
  useStore();
  const [num, setNum] = useState('');
  const p = device;
  const v = p.voice;
  const lossPct = v.received + v.lost ? (v.lost / (v.received + v.lost)) * 100 : 0;
  const quality = v.mos >= 4.2 ? "A'lo" : v.mos >= 3.8 ? 'Yaxshi' : v.mos >= 3.3 ? "O'rtacha" : v.mos > 0 ? 'Yomon' : '—';
  const press = (d: string) => setNum((n) => (n + d).slice(0, 12));
  return (
    <div className="phone">
      <div className="phone-body">
        <div className="phone-screen">
          <div className="ps-top">
            <span>{p.powered ? new Date(Date.UTC(2024, 0, 1) + p.now).toISOString().slice(11, 16) : ''}</span>
            <span>{p.primaryDn ? `☎ ${p.primaryDn}` : ''}</span>
          </div>
          {!p.powered ? (
            <div className="ps-main dim">Quvvat yo'q</div>
          ) : (
            <>
              <div className="ps-main">
                {p.state !== 'registered' ? (
                  <span>{p.statusText}</span>
                ) : p.callState === 'idle' ? (
                  <span>{num || 'Raqamni tering'}</span>
                ) : (
                  <span>
                    {STATE_TEXT[p.callState]} {p.remoteNumber || p.dialed}
                  </span>
                )}
              </div>
              <div className="ps-lines">
                {p.lines.map((l, i) => (
                  <div key={i}>
                    [{i + 1}] {l.dn}
                  </div>
                ))}
              </div>
              <div className="ps-soft">
                {p.callState === 'idle' && (
                  <button onClick={() => num && (p.dial(num), setNum(''), store.emit())} disabled={p.state !== 'registered'}>
                    Qo'ng'iroq
                  </button>
                )}
                {p.callState === 'ringing' && (
                  <button className="answer" onClick={() => (p.answer(), store.emit())}>
                    Javob
                  </button>
                )}
                {p.callState !== 'idle' && (
                  <button className="end" onClick={() => (p.hangup(), store.emit())}>
                    Tugatish
                  </button>
                )}
                {p.callState === 'idle' && <button onClick={() => setNum((n) => n.slice(0, -1))}>⌫</button>}
              </div>
            </>
          )}
        </div>
        <div className="keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => (
            <button key={k} onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="phone-info">
        <h4>Holat</h4>
        <div>
          IP: <b>{p.cpu.ip ?? '—'}</b> {p.voiceVlan ? `(Voice VLAN ${p.voiceVlan})` : "(Voice VLAN yo'q — data VLAN da)"}
        </div>
        <div>Gateway: {p.stack.defaultGateway ?? '—'}</div>
        <div>CallManager (TFTP, option 150): {p.cpu.dhcpState?.tftp ?? p.manualIp?.tftp ?? '—'}</div>
        <div>MAC: {p.mac}</div>
        <div>
          Quvvat: {p.powered ? (p.poweredViaPoe ? `PoE (${p.poeRequiredW} Vt)` : 'adapter') : "yo'q"}
          <label className="chk" style={{ marginLeft: 8 }}>
            <input type="checkbox" checked={p.acPower} onChange={(e) => ((p.acPower = e.target.checked), p.net.refresh(), store.emit())} /> adapter
          </label>
        </div>
        <h4>Ovoz sifati (RTP, G.711)</h4>
        <div className="voice-grid">
          <div>
            <b>{v.mos ? v.mos.toFixed(2) : '—'}</b>MOS ({quality})
          </div>
          <div>
            <b>{v.latencyMs.toFixed(1)} ms</b>kechikish
          </div>
          <div>
            <b>{v.jitterMs.toFixed(2)} ms</b>jitter
          </div>
          <div>
            <b>{lossPct.toFixed(1)}%</b>yo'qotish
          </div>
          <div>
            <b>{v.sent}</b>yuborildi
          </div>
          <div>
            <b>{v.received}</b>qabul qilindi
          </div>
        </div>
        <p className="hint">Tarmoq band bo'lganda ovoz buziladi. Switchda "mls qos" + portlarda "auto qos voip cisco-phone" — ovoz paketlari (DSCP EF / CoS 5) ustuvor navbatga o'tadi.</p>
        <h4>Qo'ng'iroqlar tarixi</h4>
        <div className="dim small">{p.callLog.slice(-6).join(' · ') || '—'}</div>
      </div>
    </div>
  );
}
