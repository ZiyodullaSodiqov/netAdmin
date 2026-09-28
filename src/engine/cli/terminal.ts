// Umumiy terminal sessiyasi interfeysi (UI terminali shu bilan ishlaydi).

export interface TerminalSession {
  /** Joriy prompt (masalan: "Router#", "C:\\>") */
  prompt(): string;
  /** Foydalanuvchi qatorini yuborish */
  input(line: string): void;
  /** Tab to'ldirish */
  complete?(line: string): string | null;
  /** "?" yordam — IOS da darhol ishlaydi */
  help?(line: string): void;
  /** Ctrl+C / Ctrl+Shift+6 */
  interrupt?(): void;
  /** Parol kiritilmoqda (ekranda ko'rsatilmaydi) */
  isSecret?(): boolean;
  /** Buyruq bajarilmoqda (prompt ko'rsatilmaydi) */
  isBusy?(): boolean;
  /** Chiqish oqimi */
  onOutput(fn: (text: string) => void): () => void;
  /** Sessiya yopilganda */
  onClose?(fn: () => void): void;
  close?(): void;
  history: string[];
}

export class OutputBus {
  private sinks = new Set<(t: string) => void>();
  buffer: string[] = [];
  on(fn: (t: string) => void) {
    this.sinks.add(fn);
    return () => {
      this.sinks.delete(fn);
    };
  }
  write(t: string) {
    if (!this.sinks.size) {
      this.buffer.push(t);
      if (this.buffer.length > 2000) this.buffer.splice(0, 500);
    }
    for (const s of this.sinks) s(t);
  }
  line(t = '') {
    this.write(t + '\n');
  }
}
