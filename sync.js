/**
 * sync.js — ดึงข้อมูลสินค้า/ราคา/สต๊อก จาก Worldwide Vending VMS
 * แล้วสร้างไฟล์ docs/data.json สำหรับเว็บไซต์ลูกค้า
 *
 * ใช้ Node.js 18+ (มี fetch ในตัว) ไม่ต้องติดตั้งแพ็กเกจเพิ่ม
 *
 * บัญชีอ่านจาก environment variable:
 *   VMS_ACCOUNTS = "user1:pass1,user2:pass2"
 *
 * รันเอง:  VMS_ACCOUNTS="..." node sync.js
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.worldwidevending-vms.com';
const OUT = path.join(__dirname, 'docs', 'data.json');

// ---------- helpers ----------

/** เก็บ cookie ต่อ session แบบง่าย */
class Session {
  constructor() { this.cookies = {}; }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  async fetch(url, opts = {}) {
    const headers = Object.assign({
      'Cookie': this.cookieHeader(),
      'User-Agent': 'Mozilla/5.0 (vending-site-sync)',
    }, opts.headers || {});
    const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
    this.store(res);
    // ตาม redirect เองเพื่อเก็บ cookie ระหว่างทาง
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) return this.fetch(new URL(loc, url).href, { method: 'GET' });
    }
    return res;
  }
}

const norm = s => (s || '').replace(/\s+/g, ' ').trim();

/** แปลงตาราง HTML (view_inventory) เป็น array แถว */
function parseInventoryTable(html) {
  const rows = [];
  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i);
  const scope = tbody ? tbody[0] : html;
  const trRe = /<tr[\s\S]*?<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(scope))) {
    const cells = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => norm(m[1].replace(/<[^>]+>/g, '')));
    if (cells.length >= 5 && cells[0] !== 'Aisle' && /^[0-9A-Z]{2,4}$/.test(cells[0])) {
      rows.push({
        aisle: cells[0],
        name: cells[1],
        capacity: parseInt(cells[2], 10) || 0,
        qty: parseInt(cells[3], 10) || 0,
        status: cells[4] || '',
      });
    }
  }
  return rows;
}

/** ดึงราคารายช่องจากหน้า Machine management (aisle config)
 *  ราคาที่ตั้งขายจริงต่อช่องอยู่ใน <input id="price_XXX" value="220.00">
 *  หมายเหตุ: ราคานี้คือราคาที่ใช้แสดงบนเว็บ (Goods center อาจไม่ตรง) */
function parseAislePrices(html) {
  const map = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[0];
    const idm = tag.match(/id\s*=\s*["']price_([0-9A-Za-z]+)["']/);
    if (!idm) continue;
    const vm = tag.match(/value\s*=\s*["']([\d.]+)["']/);
    if (vm) map[idm[1]] = parseFloat(vm[1]);
  }
  return map;
}

/** จับคู่ชื่อสินค้าในตู้ (อาจถูกตัดท้าย ~100 ตัวอักษร) กับรายการสินค้า */
function matchGoods(invName, goodsList) {
  const n = norm(invName);
  // 1) ตรงเป๊ะ
  let g = goodsList.find(g => norm(g.n) === n);
  if (g) return g;
  // 2) ชื่อในตู้เป็น prefix ของชื่อสินค้า (กรณีถูกตัดท้าย)
  if (n.length >= 60) {
    g = goodsList.find(g => norm(g.n).startsWith(n.slice(0, 60)));
    if (g) return g;
  }
  // 3) เทียบแบบตัดอักขระพิเศษ (เว้นวรรค/ขีดต่างกันเล็กน้อย)
  const loose = s => norm(s).toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
  const ln = loose(n);
  g = goodsList.find(g => {
    const lg = loose(g.n);
    return lg === ln || (ln.length >= 40 && (lg.startsWith(ln.slice(0, 40)) || ln.startsWith(lg.slice(0, 40))));
  });
  return g || null;
}

// ---------- main per account ----------

async function pullAccount(user, pass) {
  const s = new Session();

  // 1) login (POST form ธรรมดา)
  await s.fetch(`${BASE}/sys/login.do`); // รับ session cookie
  const body = new URLSearchParams({ loginname: user, loginpwd: pass });
  const login = await s.fetch(`${BASE}/sys/login.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const loginHtml = await login.text();
  if (/loginname/i.test(loginHtml) && /loginpwd/i.test(loginHtml)) {
    throw new Error(`เข้าสู่ระบบไม่สำเร็จสำหรับบัญชี ${user}`);
  }

  // 2) รายชื่อตู้
  const msRes = await s.fetch(`${BASE}/dod/async/multi_states/1/100.do`, {
    method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const ms = await msRes.json();
  const machines = (ms.data || []).map(m => ({
    id: m.machine, site: norm(m.site), route: norm(m.route),
    updateTime: m.updateTime || '', supplyTime: m.supplyTime || '',
  }));

  // 3) รายการสินค้า + ราคา + รูป
  const glRes = await s.fetch(`${BASE}/com/async/commodity_list/1/500.do`, {
    method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const gl = await glRes.json();
  const goods = (gl.data || [])
    .filter(g => g.goodsName && g.retailPrice > 1) // ตัดรายการ test
    .map(g => ({ n: norm(g.goodsName), p: g.retailPrice, i: g.goodsImg, c: g.categoryName || '' }));

  // 4) สต๊อกรายช่อง + ราคาที่ตั้งขายจริงรายช่อง (จาก Machine management) ของแต่ละตู้
  for (const m of machines) {
    const invRes = await s.fetch(`${BASE}/page/view_inventory/${m.id}.do`);
    const invHtml = await invRes.text();
    const cfgRes = await s.fetch(`${BASE}/aisle/load_aisle_config.do?machineNum=${m.id}`);
    const cfgHtml = await cfgRes.text();
    const aislePrice = parseAislePrices(cfgHtml); // { '010': 220, ... }
    const slots = parseInventoryTable(invHtml);
    m.slots = slots.map(sl => {
      const g = matchGoods(sl.name, goods);
      // ราคาหลัก = ราคารายช่องจาก Machine management, สำรอง = Goods center
      const p = aislePrice[sl.aisle] != null ? aislePrice[sl.aisle] : (g ? g.p : null);
      return {
        aisle: sl.aisle,
        name: g ? g.n : sl.name,
        capacity: sl.capacity,
        qty: sl.qty,
        status: sl.status,
        price: p,
        img: g && g.i ? BASE + g.i : null,
        cat: g ? g.c : '',
      };
    });
    const noPrice = m.slots.filter(x => x.price === null).length;
    const fromAisle = m.slots.filter(x => aislePrice[x.aisle] != null).length;
    console.log(`  ${m.id} (${m.site}): ${m.slots.length} ช่อง, ราคาจาก machine management ${fromAisle} ช่อง, ไม่มีราคา ${noPrice} ช่อง`);
  }
  return machines;
}

// ---------- run ----------

(async () => {
  const accStr = process.env.VMS_ACCOUNTS || '';
  const accounts = accStr.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':');
    return { user: s.slice(0, i), pass: s.slice(i + 1) };
  });
  if (!accounts.length) {
    console.error('กรุณาตั้งค่า VMS_ACCOUNTS เช่น VMS_ACCOUNTS="user1:pass1,user2:pass2"');
    process.exit(1);
  }

  const all = [];
  for (const a of accounts) {
    console.log(`กำลังดึงข้อมูลบัญชี ${a.user} ...`);
    try {
      all.push(...await pullAccount(a.user, a.pass));
    } catch (e) {
      console.error(`บัญชี ${a.user} ผิดพลาด: ${e.message}`);
    }
  }
  if (!all.length) {
    console.error('ดึงข้อมูลไม่ได้เลย — ไม่เขียนทับไฟล์เดิม');
    process.exit(1);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    machines: all,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
  console.log(`เขียน ${OUT} แล้ว: ${all.length} ตู้, อัปเดต ${out.updatedAt}`);
})();
