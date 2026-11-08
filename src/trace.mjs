import fs from 'node:fs';
import path from 'node:path';

/**
 * 结构化 trace：一行一条 JSONL。
 * 出问题时的复盘全指望它 —— 每次决策、每次派单、每次结果、每次上报都要留痕。
 */
export class Trace {
  constructor(dir, keepDays = 14) {
    this.dir = dir;
    this.keepDays = keepDays;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `trace-${this.#stamp()}.jsonl`);
  }

  #stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  write(level, kind, data = {}) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, kind, ...data });
    try {
      fs.appendFileSync(this.file, line + '\n', 'utf8');
    } catch {
      /* trace 失败不能影响主流程 */
    }
    if (level !== 'debug') {
      const brief = data.companion ? `[${data.companion}] ` : '';
      console.log(`${level.toUpperCase()} ${brief}${kind}`, data.note ?? '');
    }
  }

  info(kind, data) {
    this.write('info', kind, data);
  }

  warn(kind, data) {
    this.write('warn', kind, data);
  }

  error(kind, data) {
    this.write('error', kind, data);
  }
}
