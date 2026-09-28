// Terminal emulyatori: IOS CLI, Windows cmd, Linux shell, telnet/ssh sessiyalari uchun.
import { useEffect, useRef, useState } from 'react';
import type { TerminalSession } from '../engine/cli/terminal';

const MAX_CHARS = 150_000;

export function Terminal({ session, height = 380, autoFocus = true }: { session: TerminalSession; height?: number | string; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [value, setValue] = useState('');
  const [, force] = useState(0);
  const histIdx = useRef<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    setText('');
    setClosed(false);
    const un = session.onOutput((t) => {
      setText((prev) => {
        let next = prev;
        const clear = t.lastIndexOf('\x1b[2J');
        if (clear >= 0) {
          next = '';
          t = t.slice(clear + 4);
        }
        next += t;
        if (next.length > MAX_CHARS) next = next.slice(next.length - MAX_CHARS);
        return next;
      });
    });
    session.onClose?.(() => setClosed(true));
    // busy/secret holatlarini yangilash uchun
    const iv = setInterval(() => force((x) => x + 1), 250);
    return () => {
      un();
      clearInterval(iv);
    };
  }, [session]);

  useEffect(() => {
    const b = boxRef.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [text, value]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, session]);

  const secret = session.isSecret?.() ?? false;

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      session.input(value);
      if (value.trim() && !secret) {
        session.history.push(value);
      }
      histIdx.current = -1;
      setValue('');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const c = session.complete?.(value);
      if (c) setValue(c);
      return;
    }
    if (e.key === '?' && !secret && session.help !== undefined) {
      e.preventDefault();
      session.input(value + '?');
      return;
    }
    if (e.key === '?' && !secret && (session as any).dev) {
      // IOS: "?" darhol yordam ko'rsatadi, yozilgan qism saqlanadi
      e.preventDefault();
      session.input(value + '?');
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const h = session.history;
      if (!h.length) return;
      histIdx.current = histIdx.current < 0 ? h.length - 1 : Math.max(0, histIdx.current - 1);
      setValue(h[histIdx.current] ?? '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const h = session.history;
      if (histIdx.current < 0) return;
      histIdx.current++;
      if (histIdx.current >= h.length) {
        histIdx.current = -1;
        setValue('');
      } else setValue(h[histIdx.current]);
      return;
    }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C' || e.key === '6' || e.key === '^')) {
      e.preventDefault();
      session.interrupt?.();
      setValue('');
      return;
    }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      session.input('\x1a');
      setValue('');
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      setText('');
    }
  };

  return (
    <div className="terminal" style={{ height }} onClick={() => inputRef.current?.focus()}>
      <div className="terminal-scroll" ref={boxRef}>
        <span>{text}</span>
        {!closed && <span className="term-input">{secret ? '' : value}</span>}
        {!closed && <span className="caret">█</span>}
        {closed && <div className="term-closed">[Sessiya yopildi]</div>}
      </div>
      <input
        ref={inputRef}
        className="terminal-hidden-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
      />
    </div>
  );
}
