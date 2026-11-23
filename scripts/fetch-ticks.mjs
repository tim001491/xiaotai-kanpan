// 下載期交所「前30個交易日期貨每筆成交資料」(CSV)，挑出小台(MTX)近月、次月，整理成 1 分K
// 輸出：data/1m/YYYY-MM-DD.json（那個交易日：前一晚夜盤＋當天日盤）、data/1m/index.json（有哪些日期）
// 由 GitHub Actions 每天自動跑（.github/workflows/fetch-ticks.yml）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const OUT = 'data/1m';
const DAYS = +process.env.DAYS || 45;          // 往回找幾個日曆天
const REFRESH = +process.env.REFRESH || 3;     // 最近幾天就算有檔案也重抓（期交所早上會先放只有夜盤的版本）
const URL = d => `https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_${d}.zip`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const pad = n => String(n).padStart(2, '0');
const ymd = (d, sep) => `${d.getUTCFullYear()}${sep}${pad(d.getUTCMonth() + 1)}${sep}${pad(d.getUTCDate())}`;
const prevWeekday = d => { const x = new Date(d); do x.setUTCDate(x.getUTCDate() - 1); while ([0, 6].includes(x.getUTCDay())); return x; };

// 一行 CSV：成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),近月價格,遠月價格,開盤集合競價
export function makeParser(tradeDate) {
  const D = Date.UTC(tradeDate.getUTCFullYear(), tradeDate.getUTCMonth(), tradeDate.getUTCDate()) / 1000;
  const P = prevWeekday(tradeDate), PD = Date.UTC(P.getUTCFullYear(), P.getUTCMonth(), P.getUTCDate()) / 1000;
  const by = new Map(); // 合約 → Map(分鐘 → bar)
  return {
    line(s) {
      const f = s.split(',');
      if (f.length < 6 || f[1].trim() !== 'MTX') return;
      const k = f[2].trim();
      if (!/^\d{6}$/.test(k)) return;               // 只要月合約（排除週合約 W、價差 /）
      const T = f[3].trim().padStart(6, '0'), hh = +T.slice(0, 2), mm = +T.slice(2, 4);
      const px = parseFloat(f[4]), q = parseFloat(f[5]);
      if (!(px > 0) || !(q > 0)) return;
      // 夜盤：15:00 以後算前一個交易日的晚上，00:00–05:00 算前一個交易日的隔天凌晨
      const base = hh >= 15 ? PD : hh < 6 ? PD + 86400 : D;
      const t = base + hh * 3600 + mm * 60;
      let m = by.get(k); if (!m) by.set(k, m = new Map());
      const b = m.get(t);
      if (b) { if (px > b[2]) b[2] = px; if (px < b[3]) b[3] = px; b[4] = px; b[5] += q; }
      else m.set(t, [t, px, px, px, px, q]);
    },
    result() {
      const ks = [...by.keys()].sort();
      const pack = k => k && { k, bars: [...by.get(k).values()].sort((a, b) => a[0] - b[0]).map(b => [b[0], b[1], b[2], b[3], b[4], Math.round(b[5] / 2)]) }; // B+S 兩邊都算，除以 2＝口數
      return { near: pack(ks[0]), next: pack(ks[1]) };
    }
  };
}

async function parseZip(file, tradeDate) {
  const p = makeParser(tradeDate);
  const child = spawn('unzip', ['-p', file]);
  child.stdout.setEncoding('latin1'); // 檔案是 Big5，我們只用到英數字欄位
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const s of rl) p.line(s);
  await new Promise(r => child.on('close', r));
  return p.result();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tw = new Date(Date.now() + 8 * 3600e3);
  const today = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
  let got = 0;
  for (let i = 0; i <= DAYS; i++) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - i);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const out = path.join(OUT, ymd(d, '-') + '.json');
    if (fs.existsSync(out) && i > REFRESH) continue;
    const r = await fetch(URL(ymd(d, '_')), { headers: { 'User-Agent': UA } }).catch(() => null);
    if (!r || !r.ok) { console.log(ymd(d, '-'), '沒有檔案', r?.status || ''); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) { console.log(ymd(d, '-'), '不是 ZIP，略過'); continue; }
    const tmp = path.join(os.tmpdir(), `d${i}.zip`); fs.writeFileSync(tmp, buf);
    const res = await parseZip(tmp, d); fs.unlinkSync(tmp);
    if (!res.near) { console.log(ymd(d, '-'), '沒有小台資料'); continue; }
    fs.writeFileSync(out, JSON.stringify({ date: ymd(d, '-'), ...res }));
    console.log(ymd(d, '-'), `近月 ${res.near.k} ${res.near.bars.length} 根`, res.next ? `次月 ${res.next.k} ${res.next.bars.length} 根` : '');
    got++;
  }
  const dates = fs.readdirSync(OUT).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), dates }));
  console.log(`完成：這次處理 ${got} 天，共有 ${dates.length} 天`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
