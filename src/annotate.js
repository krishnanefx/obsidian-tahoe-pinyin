// Text → pieces, each either plain text or one Chinese character with its
// pinyin. pinyin-pro reads whole phrases, so a character with several readings
// gets the one its word needs: 银行 yín háng, 行走 xíng zǒu, 重庆 chóng qìng.
// Where its dictionary doesn't know a word, corrections (built in, and your
// own) fix the reading: 律师行 lǜ shī háng.

// pinyin-pro and its dictionary (most of the plugin's size) load the first time
// they're needed, in idle time after Obsidian opens, so starting Obsidian never
// waits for them. Until then there's simply no pinyin yet.
let engine = null;
let loading = null;
export function loadEngine() {
  if (!loading)
    loading = import("pinyin-pro").then((m) => {
      engine = m;
      return m;
    });
  return loading;
}
export function engineReady() {
  return engine !== null;
}

// CJK ideographs: the main block, Extension A, compatibility ideographs, and
// Extensions B and later.
export const HAN = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{3134f}]/u;
// Kana: text with it is Japanese, whose kanji pinyin would only mislabel.
export const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;

export function wanted(text, settings = {}) {
  if (!HAN.test(text)) return false;
  if (settings.skipJapanese !== false && KANA.test(text)) return false;
  return true;
}

/* ---- Corrections ---- */

// 行 háng is a firm or shop, but pinyin-pro reads these as xíng. Each is
// skipped when the next character makes 行 a xíng word instead: 律师行动,
// 开车行驶, 吃药行不行, 这个车行吗.
const XING_AFTER = /^[动为驶走李人程使政进事善医礼星径刑吗不了啊吧呢得过来去将]/u;
const BUILT_IN = {
  律师行: "lǜ shī háng",
  琴行: "qín háng",
  车行: "chē háng",
  花行: "huā háng",
  米行: "mǐ háng",
  粮行: "liáng háng",
  药行: "yào háng",
  金行: "jīn háng",
  投行: "tóu háng",
  央行: "yāng háng",
  分行: "fēn háng",
  排行: "pái háng",
  典当行: "diǎn dàng háng",
  拍卖行: "pāi mài háng",
  五金行: "wǔ jīn háng",
  电器行: "diàn qì háng",
  珠宝行: "zhū bǎo háng",
};

// One syllable as you might type it (lv4, lü4, lu:4, de5, hang2, háng) → háng.
export function toMarks(syllable) {
  const s = String(syllable).trim().toLowerCase().replace(/u:|v/g, "\u00fc").normalize("NFC");
  const m = s.match(/^([a-z\u00c0-\u024f]+)([0-5])$/u);
  if (!m || !engine) return s;
  if (m[2] === "0" || m[2] === "5") return m[1];
  return engine.convert(m[1] + m[2], { format: "numToSymbol" });
}

/* ---- Zhuyin (bopomofo) ---- */

const ZY_INITIALS = { zh: "ㄓ", ch: "ㄔ", sh: "ㄕ", b: "ㄅ", p: "ㄆ", m: "ㄇ", f: "ㄈ", d: "ㄉ", t: "ㄊ", n: "ㄋ", l: "ㄌ", g: "ㄍ", k: "ㄎ", h: "ㄏ", j: "ㄐ", q: "ㄑ", x: "ㄒ", r: "ㄖ", z: "ㄗ", c: "ㄘ", s: "ㄙ" };
const ZY_FINALS = {
  a: "ㄚ", o: "ㄛ", e: "ㄜ", "\u00ea": "ㄝ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ", an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ", ong: "ㄨㄥ",
  i: "ㄧ", ia: "ㄧㄚ", ie: "ㄧㄝ", io: "ㄧㄛ", iao: "ㄧㄠ", iou: "ㄧㄡ", ian: "ㄧㄢ", in: "ㄧㄣ", iang: "ㄧㄤ", ing: "ㄧㄥ", iong: "ㄩㄥ",
  u: "ㄨ", ua: "ㄨㄚ", uo: "ㄨㄛ", uai: "ㄨㄞ", uei: "ㄨㄟ", uan: "ㄨㄢ", uen: "ㄨㄣ", uang: "ㄨㄤ", ueng: "ㄨㄥ",
  "\u00fc": "ㄩ", "\u00fce": "ㄩㄝ", "\u00fcan": "ㄩㄢ", "\u00fcn": "ㄩㄣ",
};
const ZY_TONES = { 1: "", 2: "ˊ", 3: "ˇ", 4: "ˋ" };
const BARE_I = ["zh", "ch", "sh", "r", "z", "c", "s"]; // zhi, ci…: the i is silent

// A syllable with its tone number (zhong1, lü4, de0) → zhuyin (ㄓㄨㄥ, ㄌㄩˋ, ˙ㄉㄜ).
// Interjections without a vowel (m, ng, hm) come back as they are.
export function toZhuyin(numbered) {
  const m = String(numbered).match(/^([a-z\u00fc\u00ea]+)([0-5]?)$/u);
  if (!m) return numbered;
  const syl = m[1];
  const tone = Number(m[2]) || 5;
  let ini = Object.keys(ZY_INITIALS).find((i) => syl.startsWith(i) && syl.length > i.length) || "";
  let fin = syl.slice(ini.length);
  if (!ini && syl.startsWith("y")) {
    fin = syl.slice(1);
    fin = fin.startsWith("u") ? "\u00fc" + fin.slice(1) : fin.startsWith("i") ? fin : "i" + fin;
  } else if (!ini && syl.startsWith("w")) {
    fin = syl === "wu" ? "u" : "u" + syl.slice(1);
  } else if (ini) {
    if ("jqx".includes(ini) && fin.startsWith("u")) fin = "\u00fc" + fin.slice(1);
    if (fin === "iu") fin = "iou";
    else if (fin === "ui") fin = "uei";
    else if (fin === "un") fin = "uen";
    if (BARE_I.includes(ini) && fin === "i") fin = "";
  }
  if (fin && !ZY_FINALS[fin]) return syl;
  const body = (ZY_INITIALS[ini] || "") + (fin ? ZY_FINALS[fin] : "");
  return tone === 5 ? "˙" + body : body + ZY_TONES[tone];
}

// A syllable's tone number and its other spellings, worked out once each.
const styles = new Map();
function styled(marked) {
  let st = styles.get(marked);
  if (!st) {
    const num = engine.convert(marked, { format: "symbolToNum" });
    st = { tone: Number((num.match(/([0-4])$/) || [])[1]) || 5, num: num.replace(/0$/, ""), none: engine.convert(marked, { format: "toneNone" }), zhuyin: toZhuyin(num) };
    styles.set(marked, st);
  }
  return st;
}

// Your corrections, one per line: 律师行 lǜ shī háng (or lv4 shi1 hang2;
// "=" or ":" after the word works too). Lines starting with # are notes.
export function parseCorrections(text) {
  const list = [];
  const errors = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+?)\s*(?:[=:：]|\s)\s*(.+)$/u);
    const chars = m ? [...m[1]] : [];
    if (!m || !chars.every((c) => HAN.test(c))) {
      errors.push(`“${line}”: start with the Chinese word, then its pinyin`);
      continue;
    }
    const py = m[2].trim().split(/[\s'’-]+/).filter(Boolean).map(toMarks);
    if (py.length !== chars.length) {
      errors.push(`“${line}”: ${chars.length} character${chars.length === 1 ? "" : "s"} but ${py.length} syllable${py.length === 1 ? "" : "s"}`);
      continue;
    }
    list.push({ word: m[1], chars, py });
  }
  return { list, errors };
}

// Your corrections and the built-in ones, ready for annotate(). Yours win.
export function buildFixes(text) {
  const byWord = new Map();
  for (const [word, py] of Object.entries(BUILT_IN)) byWord.set(word, { word, chars: [...word], py: py.split(" "), guard: XING_AFTER });
  for (const fix of parseCorrections(text).list) byWord.set(fix.word, fix);
  // By first character, longest first, so 律师行动 (if you add it) beats 律师行.
  const index = new Map();
  for (const fix of byWord.values()) {
    if (!index.has(fix.chars[0])) index.set(fix.chars[0], []);
    index.get(fix.chars[0]).push(fix);
  }
  for (const list of index.values()) list.sort((a, b) => b.chars.length - a.chars.length);
  return { index, byWord };
}

let defaultFixes = null;
function defaults() {
  if (!defaultFixes) defaultFixes = buildFixes("");
  return defaultFixes;
}

/* ---- Annotating ---- */

// "symbol": zhōng, "num": zhong1, "none": zhong.
export function annotate(text, settings = {}, fixes = defaults()) {
  if (!engine || !HAN.test(text)) return [{ text, py: null }];
  const tone = settings.tone === "num" || settings.tone === "none" ? settings.tone : "symbol";
  let items;
  try {
    items = engine.pinyin(text, { type: "all", toneType: "symbol" });
  } catch {
    return [{ text, py: null }];
  }
  // Every piece must come back as it went in, or the note's text would change.
  if (items.map((i) => i.origin).join("") !== text) return [{ text, py: null }];

  const marks = items.map((it) => (it.isZh && it.pinyin && HAN.test(it.origin) ? it.pinyin : null));
  for (let i = 0; i < items.length; ) {
    const fix = marks[i] !== null && (fixes.index.get(items[i].origin) || []).find((f) => f.chars.every((c, k) => items[i + k] && items[i + k].origin === c) && !(f.guard && items[i + f.chars.length] && f.guard.test(items[i + f.chars.length].origin)));
    if (fix) {
      fix.py.forEach((p, k) => (marks[i + k] = p));
      i += fix.chars.length;
    } else i++;
  }

  // Characters you know show no pinyin (their neighbours' readings still use them).
  const known = settings.knownSet;
  const out = [];
  items.forEach((it, i) => {
    if (marks[i] !== null && !(known && known.has(it.origin))) {
      const st = styled(marks[i]);
      const py = settings.script === "zhuyin" ? st.zhuyin : tone === "symbol" ? marks[i] : st[tone];
      out.push({ text: it.origin, py, tone: st.tone });
    } else {
      const last = out[out.length - 1];
      if (last && last.py === null) last.text += it.origin;
      else out.push({ text: it.origin, py: null });
    }
  });
  return out;
}

/* ---- Readings written in a note: {律师行|lǜ shī háng}, or {文字|-} for none ---- */

const MANUAL = /\{([^{}|\n]+)\|([^{}\n]*)\}/gu;

function shown(text, marked, settings) {
  if (!engine) return { text, py: marked, tone: 5 };
  const st = styled(marked);
  const tone = settings.tone === "num" || settings.tone === "none" ? settings.tone : "symbol";
  return { text, py: settings.script === "zhuyin" ? st.zhuyin : tone === "symbol" ? marked : st[tone], tone: st.tone };
}

// Each {word|reading} in a line: where it is, where its word is, and the pieces it
// shows. One syllable per character gives each its own; any other reading is
// shown as written over the whole word; "-" shows none.
export function findManual(text, settings = {}) {
  const out = [];
  for (const m of String(text).matchAll(MANUAL)) {
    const word = m[1];
    const chars = [...word];
    if (!chars.every((c) => HAN.test(c))) continue;
    const raw = m[2].trim();
    const syllables = raw.split(/[\s'’]+/).filter(Boolean);
    if (!syllables.length) continue;
    let pieces;
    if (raw === "-") pieces = [{ text: word, py: null }];
    else if (syllables.length === chars.length) pieces = chars.map((c, i) => shown(c, toMarks(syllables[i]), settings));
    else pieces = [{ text: word, py: raw, tone: 5 }];
    const from = m.index;
    out.push({ from, to: from + m[0].length, wordFrom: from + 1, wordTo: from + 1 + word.length, pieces });
  }
  return out;
}

// Text → pieces, with written readings in place of the braces and the rest read
// as usual by `read`.
export function withManual(text, settings, read) {
  const found = findManual(text, settings);
  if (!found.length) return read(text);
  const out = [];
  let at = 0;
  for (const f of found) {
    if (f.from > at) out.push(...read(text.slice(at, f.from)));
    out.push(...f.pieces);
    at = f.to;
  }
  if (at < text.length) out.push(...read(text.slice(at)));
  return out;
}

// The reading of a word as one string with tone marks, for the Fix pinyin box.
export function readingOf(word, fixes = defaults()) {
  return annotate(word, { tone: "symbol" }, fixes)
    .filter((p) => p.py !== null)
    .map((p) => p.py)
    .join(" ");
}

// annotate(), remembered: the editor asks again for every visible line on every
// cursor move, and a line that hasn't changed reads the same. Make a new one
// whenever the settings or corrections change.
export function cachedAnnotator(settings, fixes, limit = 4000) {
  const memo = new Map();
  return (text) => {
    let pieces = memo.get(text);
    if (!pieces) {
      pieces = annotate(text, settings, fixes);
      if (!engine) return pieces; // not loaded yet: don't remember "no pinyin"
      if (memo.size >= limit) memo.clear();
      memo.set(text, pieces);
    }
    return pieces;
  };
}
