/*
 * Tahoe Pinyin — pinyin above Chinese characters, in Reading view and Live
 * Preview. The note's text never changes: the pinyin is drawn, not written.
 *
 *   我去银行。      →   wǒ qù yín háng over each character
 *
 * The line you're editing shows plain text, so typing with a Chinese input
 * method is never disturbed; the pinyin comes back when you move off it.
 * A note can opt out with `pinyin: false` in its properties (or opt in with
 * `pinyin: true` when pinyin is set to show only where asked for).
 *
 * A wrong reading? Select the word and run "Fix pinyin" (or right-click):
 * the correction applies wherever that word appears.
 */

import { MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, debounce, editorInfoField, editorLivePreviewField } from "obsidian";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { HAN, buildFixes, cachedAnnotator, loadEngine, parseCorrections, readingOf, toMarks, wanted } from "./annotate.js";

const DEFAULTS = {
  enabled: true,
  where: "all", // "all" notes, or only notes with `pinyin: true`
  reading: true,
  editor: true,
  script: "pinyin", // or "zhuyin" (bopomofo)
  tone: "symbol", // "symbol" zhōng · "num" zhong1 · "none" zhong
  colors: false, // tone colours
  toneColors: ["", "", "", "", ""], // your own colour for tones 1-4 and neutral; "" keeps the built-in one
  hover: false, // pinyin only under the pointer, for practice
  size: 50, // percent of the text size
  skipJapanese: true,
  corrections: "", // your own readings, one per line: 律师行 lǜ shī háng
  known: "", // characters you know, which get no pinyin
  hideKnown: true,
  voice: "", // the system voice for Read aloud; "" picks a Chinese one
  rate: 1, // Read aloud speed
};

const refresh = StateEffect.define();

// Elements whose text is never annotated.
const SKIP = "code, pre, rt, rp, ruby, script, style, textarea, svg, math, mjx-container, .math, .frontmatter, .tahoe-pinyin-off, .cm-editor";
// Live Preview syntax nodes that are code, maths, properties, comments or HTML.
const SKIP_NODE = /codeblock|inline-code|code-block|frontmatter|math|comment|html|hmd-escape|url/;

// `read` turns text into pieces: annotate() or a cachedAnnotator().
export function rubify(root, settings, read) {
  if (!wanted(root.textContent || "", settings)) return 0;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!wanted(n.data, { skipJapanese: false }) || (n.parentElement && n.parentElement.closest(SKIP)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const node of nodes) {
    const doc = node.ownerDocument;
    const frag = doc.createDocumentFragment();
    for (const piece of read(node.data)) {
      if (piece.py === null) {
        frag.appendChild(doc.createTextNode(piece.text));
        continue;
      }
      const ruby = doc.createElement("ruby");
      ruby.className = "tahoe-pinyin";
      ruby.appendChild(doc.createTextNode(piece.text));
      const rt = doc.createElement("rt");
      rt.className = `tahoe-pinyin-rt tahoe-pinyin-t${piece.tone}`;
      rt.textContent = piece.py;
      ruby.appendChild(rt);
      frag.appendChild(ruby);
      count++;
    }
    node.replaceWith(frag);
  }
  return count;
}

function editorDecorations(view, plugin) {
  const s = plugin.settings;
  if (!s.enabled || !s.editor) return Decoration.none;
  if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
  const info = view.state.field(editorInfoField, false);
  if (!plugin.enabledFor(info && info.file)) return Decoration.none;

  const doc = view.state.doc;
  // Lines with the cursor or selection on them stay plain text while you edit.
  const editing = new Set();
  if (view.hasFocus)
    for (const r of view.state.selection.ranges) for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) editing.add(l);

  const builder = new RangeSetBuilder();
  const tree = syntaxTree(view.state);
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= lastLine) continue;
      lastLine = line.number;
      if (editing.has(line.number) || !wanted(line.text, s)) continue;

      const skip = [];
      tree.iterate({
        from: line.from,
        to: line.to,
        enter: (n) => {
          if (SKIP_NODE.test(n.name)) skip.push([Math.max(n.from, line.from), Math.min(n.to, line.to)]);
        },
      });
      const marks = [];
      let at = line.from;
      const take = (a, b) => {
        if (b <= a) return;
        let off = a;
        for (const piece of plugin.read(doc.sliceString(a, b))) {
          const end = off + piece.text.length;
          if (piece.py !== null)
            marks.push(Decoration.mark({ class: `tahoe-pinyin-c tahoe-pinyin-t${piece.tone}`, attributes: { "data-py": piece.py } }).range(off, end));
          off = end;
        }
      };
      for (const [a, b] of skip.sort((x, y) => x[0] - y[0])) {
        take(at, a);
        at = Math.max(at, b);
      }
      take(at, line.to);
      if (!marks.length) continue;
      builder.add(line.from, line.from, Decoration.line({ class: "tahoe-pinyin-line" }));
      for (const m of marks) builder.add(m.from, m.to, m.value);
    }
  }
  return builder.finish();
}

function editorExtension(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = editorDecorations(view, plugin);
      }
      update(u) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.state) !== syntaxTree(u.startState) ||
          u.state.field(editorLivePreviewField, false) !== u.startState.field(editorLivePreviewField, false) ||
          u.transactions.some((t) => t.effects.some((e) => e.is(refresh)))
        )
          this.decorations = editorDecorations(u.view, plugin);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export default class TahoePinyin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.toneColors = DEFAULTS.toneColors.map((d, i) => (this.settings.toneColors && this.settings.toneColors[i]) || d);
    this.rebuild();

    // The theme's classes and colours go on every window, pop-outs included.
    this.docs = new Set([activeDocument]);
    this.app.workspace.iterateAllLeaves((leaf) => this.docs.add(leaf.view.containerEl.ownerDocument));
    for (const doc of this.docs) this.watch(doc);
    this.registerEvent(
      this.app.workspace.on("window-open", (_, win) => {
        this.docs.add(win.document);
        this.watch(win.document);
      })
    );
    this.registerEvent(this.app.workspace.on("window-close", (_, win) => this.docs.delete(win.document)));
    this.applyLook();

    // The dictionary loads once Obsidian has a moment; then the pinyin appears.
    this.app.workspace.onLayoutReady(() => {
      const go = () =>
        loadEngine().then(() => {
          this.rebuild();
          this.refreshAll();
        });
      if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: 2000 });
      else window.setTimeout(go, 300);
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      const s = this.settings;
      if (!s.enabled || !s.reading) return;
      const fm = ctx.frontmatter || this.frontmatter(ctx.sourcePath);
      if (!this.allowed(fm)) return;
      rubify(el, s, this.read);
    });
    this.registerEditorExtension(editorExtension(this));

    // `pinyin: true/false` in a note's properties takes effect at once.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
          if (leaf.view.file && leaf.view.file.path === file.path) this.refreshLeaf(leaf);
      })
    );

    this.addCommand({
      id: "toggle",
      name: "Show or hide pinyin",
      callback: () => this.update({ enabled: !this.settings.enabled }),
    });
    this.addCommand({
      id: "toggle-note",
      name: "Show or hide pinyin in this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) {
          const on = this.enabledFor(file);
          this.app.fileManager.processFrontMatter(file, (fm) => {
            fm.pinyin = !on;
          });
          if (!this.settings.enabled && !on) this.update({ enabled: true });
        }
        return true;
      },
    });
    this.addCommand({
      id: "toggle-hover",
      name: "Show pinyin only under the pointer (practice)",
      callback: () => this.update({ hover: !this.settings.hover }),
    });

    this.addCommand({
      id: "fix",
      name: "Fix pinyin for the selected word",
      editorCheckCallback: (checking, editor) => {
        const word = fixable(editor.getSelection());
        if (!word) return false;
        if (!checking) this.openFix(word);
        return true;
      },
    });
    this.addCommand({
      id: "know",
      name: "I know the selected characters",
      editorCheckCallback: (checking, editor) => {
        if (!wanted(editor.getSelection(), {})) return false;
        if (!checking) this.markKnown(editor.getSelection(), true);
        return true;
      },
    });
    this.addCommand({
      id: "unknow",
      name: "Show pinyin for the selected characters again",
      editorCheckCallback: (checking, editor) => {
        if (!hanOf(editor.getSelection()).some((c) => this.knownSet().has(c))) return false;
        if (!checking) this.markKnown(editor.getSelection(), false);
        return true;
      },
    });
    this.addCommand({
      id: "read-aloud",
      name: "Read aloud",
      checkCallback: (checking) => {
        const text = this.textToRead();
        if (!text) return false;
        if (!checking) this.speak(text);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const word = fixable(editor.getSelection());
        if (word) menu.addItem((item) => item.setTitle("Fix pinyin…").setIcon("languages").onClick(() => this.openFix(word)));
        const text = editor.getSelection();
        if (wanted(text, {})) {
          menu.addItem((item) => item.setTitle("Read aloud").setIcon("volume-2").onClick(() => this.speak(text)));
          menu.addItem((item) => item.setTitle("I know these characters").setIcon("check").onClick(() => this.markKnown(text, true)));
          if (hanOf(text).some((c) => this.knownSet().has(c))) menu.addItem((item) => item.setTitle("Show pinyin for these again").setIcon("undo-2").onClick(() => this.markKnown(text, false)));
        }
      })
    );

    this.settingTab = new PinyinSettings(this.app, this);
    this.addSettingTab(this.settingTab);
    // The system's voices arrive a moment after startup; list them once they do.
    const synth = window.speechSynthesis;
    if (synth) {
      const listVoices = () => this.settingTab.update();
      synth.addEventListener("voiceschanged", listVoices);
      this.register(() => synth.removeEventListener("voiceschanged", listVoices));
    }
  }

  knownSet() {
    return new Set(hanOf(this.settings.known));
  }

  // Add the selection's characters to the ones you know, or take them off.
  async markKnown(text, know) {
    const set = this.knownSet();
    const chars = [...new Set(hanOf(text))];
    for (const c of chars) know ? set.add(c) : set.delete(c);
    await this.update({ known: [...set].join("") });
    new Notice(know ? `No pinyin over ${chars.join("")} now. ${set.size} characters you know.` : `Pinyin is back over ${chars.join("")}.`);
  }

  // What Read aloud reads: the selection, or else the line (or paragraph) you're on.
  textToRead() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    let text = "";
    if (view.getMode() === "source") {
      const editor = view.editor;
      text = editor.getSelection() || editor.getLine(editor.getCursor().line);
    } else {
      const doc = view.containerEl.ownerDocument;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && view.containerEl.contains(sel.anchorNode)) text = plainSelection(doc, sel);
    }
    return wanted(text, {}) ? text.trim() : null;
  }

  // The system's Chinese voice: offline, on Mac, iPhone and iPad.
  voices() {
    const synth = window.speechSynthesis;
    return synth ? synth.getVoices().filter((v) => /^(zh|cmn|yue)\b/i.test(v.lang)) : [];
  }

  speak(text) {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      new Notice("Reading aloud isn't available on this device.");
      return;
    }
    const voices = this.voices();
    const voice = voices.find((v) => v.voiceURI === this.settings.voice) || voices.find((v) => /^tingting/i.test(v.name)) || voices.find((v) => /^zh[-_]CN/i.test(v.lang)) || voices[0];
    if (!voice && synth.getVoices().length) new Notice("No Chinese voice is installed. Add one in your system's spoken content settings, then try again.");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice ? voice.lang : "zh-CN";
    if (voice) utterance.voice = voice;
    utterance.rate = this.settings.rate;
    synth.cancel();
    synth.speak(utterance);
  }

  openFix(word) {
    loadEngine().then(() => {
      this.rebuild();
      new FixModal(this, word).open();
    });
  }

  // Readings depend on the tone style, Japanese skipping and corrections; the
  // cache starts over whenever one changes.
  rebuild() {
    this.fixes = buildFixes(this.settings.corrections);
    const knownSet = this.settings.hideKnown ? this.knownSet() : null;
    this.read = cachedAnnotator(Object.assign({}, this.settings, { knownSet: knownSet && knownSet.size ? knownSet : null }), this.fixes);
  }

  watch(doc) {
    // Practice mode on a touch screen: tap a character to see its pinyin.
    this.registerDomEvent(doc, "click", (e) => {
      if (!this.settings.hover) return;
      const ruby = e.target instanceof doc.defaultView.Element ? e.target.closest("ruby.tahoe-pinyin") : null;
      if (ruby) ruby.classList.toggle("is-shown");
    });
    // Copying from Reading view gives the text without its pinyin.
    this.registerDomEvent(doc, "copy", (e) => copyWithoutPinyin(e, doc));
  }

  // Your correction for a word: the reading, or "" to drop it.
  async setCorrection(word, reading) {
    const lines = String(this.settings.corrections || "")
      .split(/\r?\n/)
      .filter((l) => {
        const m = l.trim().match(/^(\S+?)(?:\s*[=:：]|\s)/u);
        return !(m && m[1] === word);
      });
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (reading) lines.push(`${word} ${reading}`);
    await this.update({ corrections: lines.join("\n") });
  }

  onunload() {
    const off = { "--tahoe-pinyin-size": "" };
    for (let i = 1; i <= 5; i++) off[`--tahoe-pinyin-t${i}`] = "";
    for (const doc of this.docs) {
      doc.body.classList.remove("tahoe-pinyin-colors", "tahoe-pinyin-hover");
      doc.body.setCssProps(off);
    }
    this.refreshAll();
  }

  frontmatter(path) {
    const cache = path && this.app.metadataCache.getCache(path);
    return cache && cache.frontmatter;
  }

  allowed(fm) {
    const v = fm && fm.pinyin;
    if (v === false || v === "false" || v === "no" || v === "off") return false;
    if (this.settings.where === "all") return true;
    return v === true || v === "true" || v === "yes" || v === "on";
  }

  enabledFor(file) {
    if (!this.settings.enabled) return false;
    return this.allowed(file ? this.frontmatter(file.path) : null);
  }

  async update(patch) {
    Object.assign(this.settings, patch);
    if (["corrections", "script", "tone", "skipJapanese", "known", "hideKnown"].some((k) => k in patch)) this.rebuild();
    await this.saveData(this.settings);
    this.applyLook();
    // Colours, practice mode and size are CSS only: nothing to redraw.
    if (Object.keys(patch).some((k) => !["colors", "toneColors", "hover", "size"].includes(k))) this.refreshAll();
  }

  applyLook() {
    const s = this.settings;
    // "" leaves a tone on the stylesheet's own colour.
    const props = { "--tahoe-pinyin-size": `${s.size / 100}em` };
    s.toneColors.forEach((c, i) => (props[`--tahoe-pinyin-t${i + 1}`] = c || ""));
    for (const doc of this.docs) {
      doc.body.classList.toggle("tahoe-pinyin-colors", !!s.colors);
      doc.body.classList.toggle("tahoe-pinyin-hover", !!s.hover);
      doc.body.setCssProps(props);
    }
  }

  refreshLeaf(leaf) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    if (view.previewMode) view.previewMode.rerender(true);
    const cm = view.editor && view.editor.cm;
    if (cm) cm.dispatch({ effects: refresh.of(null) });
  }

  refreshAll() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.refreshLeaf(leaf);
  }
}

// A copy that takes in rendered pinyin puts the text on the clipboard without
// it: 银行, not 银yín行háng. The pinyin is hidden just while the selection's
// text is read, all before the next frame, so nothing on screen moves.
function copyWithoutPinyin(e, doc) {
  const sel = doc.getSelection();
  if (!e.clipboardData || !sel || sel.isCollapsed || !sel.rangeCount) return;
  const frag = sel.getRangeAt(0).cloneContents();
  const rts = frag.querySelectorAll("rt.tahoe-pinyin-rt");
  if (!rts.length) return;
  const text = plainSelection(doc, sel);
  rts.forEach((rt) => rt.remove());
  const holder = doc.createElement("div");
  holder.appendChild(frag);
  e.clipboardData.setData("text/plain", text);
  e.clipboardData.setData("text/html", holder.innerHTML);
  e.preventDefault();
}

// The Chinese characters in a piece of text.
function hanOf(text) {
  return [...String(text || "")].filter((c) => HAN.test(c));
}

// The selection's text as the page shows it, without the pinyin.
function plainSelection(doc, sel) {
  doc.body.classList.add("tahoe-pinyin-copying");
  const text = sel.toString();
  doc.body.classList.remove("tahoe-pinyin-copying");
  return text;
}

// The selection, if it's a Chinese word that can take a correction.
function fixable(selection) {
  const word = String(selection || "").trim();
  const chars = [...word];
  return chars.length && chars.length <= 12 && chars.every((c) => HAN.test(c)) ? word : null;
}

class FixModal extends Modal {
  constructor(plugin, word) {
    super(plugin.app);
    this.plugin = plugin;
    this.word = word;
  }

  onOpen() {
    const { contentEl } = this;
    const p = this.plugin;
    const chars = [...this.word];
    const mine = parseCorrections(p.settings.corrections).list.find((f) => f.word === this.word);
    this.titleEl.setText("Fix pinyin");
    contentEl.addClass("tahoe-pinyin-fix");
    contentEl.createDiv({ cls: "tahoe-pinyin-fix-word", text: this.word });
    let value = readingOf(this.word, p.fixes);
    const error = contentEl.createDiv({ cls: "tahoe-pinyin-fix-error" });
    const save = async () => {
      const py = value.trim().split(/[\s'’-]+/).filter(Boolean).map(toMarks);
      if (py.length !== chars.length) {
        error.setText(`${chars.length} character${chars.length === 1 ? "" : "s"}, so ${chars.length} syllable${chars.length === 1 ? "" : "s"}, with spaces between them.`);
        return;
      }
      await p.setCorrection(this.word, py.join(" "));
      new Notice(`${this.word}: ${py.join(" ")}`);
      this.close();
    };
    new Setting(contentEl)
      .setName("Pinyin")
      .setDesc("Tone numbers work too: lv4 shi1 hang2. It applies wherever this word appears.")
      .addText((t) => {
        t.setValue(value).onChange((v) => {
          value = v;
          error.setText("");
        });
        t.inputEl.addClass("tahoe-pinyin-fix-input");
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            save();
          }
        });
        window.setTimeout(() => t.inputEl.select(), 0);
      });
    const buttons = new Setting(contentEl);
    if (mine)
      buttons.addButton((b) =>
        b.setButtonText("Remove my correction").onClick(async () => {
          await p.setCorrection(this.word, "");
          this.close();
        })
      );
    buttons.addButton((b) => b.setButtonText("Save").setCta().onClick(save));
  }

  onClose() {
    this.contentEl.empty();
  }
}

// A CSS colour (color-mix() included) as #rrggbb, for the colour picker.
function toHex(css) {
  const doc = activeDocument;
  const el = doc.body.createDiv();
  el.setCssProps({ color: css.trim() });
  const rgb = doc.defaultView.getComputedStyle(el).color;
  el.remove();
  const nums = (rgb.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  // color-mix() can come back as color(srgb r g b) with 0-1 channels.
  const scale = /^color\(/.test(rgb) ? 255 : 1;
  return "#" + nums.map((n) => Math.round(n * scale).toString(16).padStart(2, "0")).join("");
}

const TONES = ["First tone (ā)", "Second tone (á)", "Third tone (ǎ)", "Fourth tone (à)", "Neutral tone (a)"];

// Settings, declared rather than drawn, so Obsidian's settings search finds them.
class PinyinSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Corrections are saved once you pause typing, not on every key.
    this.saveCorrections = debounce((v) => this.plugin.update({ corrections: v }), 600, true);
    this.saveKnown = debounce((v) => this.plugin.update({ known: v }), 600, true);
  }

  getControlValue(key) {
    const s = this.plugin.settings;
    const tone = key.match(/^tone([1-5])$/);
    // Without a colour of your own, the picker shows the built-in tint.
    if (tone) return s.toneColors[tone[1] - 1] || toHex(activeDocument.defaultView.getComputedStyle(activeDocument.body).getPropertyValue(`--tahoe-pinyin-t${tone[1]}`));
    return s[key];
  }

  async setControlValue(key, value) {
    const p = this.plugin;
    const tone = key.match(/^tone([1-5])$/);
    if (tone) {
      const next = p.settings.toneColors.slice();
      next[tone[1] - 1] = value;
      await p.update({ toneColors: next });
    } else if (key === "corrections") {
      p.settings.corrections = value;
      this.saveCorrections(value);
    } else if (key === "known") {
      p.settings.known = value;
      this.saveKnown(value);
    } else await p.update({ [key]: value });
    if (key === "script") this.refreshDomState();
    // Tone colour rows show only with tone colours on, and "back to built-in"
    // only once you've picked your own.
    if (key === "colors" || tone) this.refreshDomState();
  }

  getSettingDefinitions() {
    const s = () => this.plugin.settings;
    const custom = () => s().colors && s().toneColors.some(Boolean);
    return [
      {
        type: "group",
        items: [
          { name: "Show pinyin", desc: "Pinyin above Chinese characters. The note's text doesn't change.", control: { type: "toggle", key: "enabled" } },
          {
            name: "Which notes",
            desc: "Any note can override this with pinyin: true or pinyin: false in its properties.",
            control: { type: "dropdown", key: "where", options: { all: "Every note with Chinese", property: "Only notes with pinyin: true" } },
          },
          { name: "Reading view", control: { type: "toggle", key: "reading" } },
          { name: "Live Preview", desc: "The line you're editing shows plain text, so your input method works as usual.", control: { type: "toggle", key: "editor" } },
        ],
      },
      {
        type: "group",
        heading: "Look",
        items: [
          {
            name: "Show",
            desc: "Pinyin, or zhuyin (bopomofo), as used in Taiwan.",
            aliases: ["bopomofo", "zhuyin", "注音"],
            control: { type: "dropdown", key: "script", options: { pinyin: "Pinyin (zhōng)", zhuyin: "Zhuyin (ㄓㄨㄥ)" } },
          },
          { name: "Tones", visible: () => s().script !== "zhuyin", control: { type: "dropdown", key: "tone", options: { symbol: "Marks (zhōng)", num: "Numbers (zhong1)", none: "None (zhong)" } } },
          { name: "Tone colors", desc: "Soft tints: first tone red, second orange, third green, fourth blue, neutral gray.", aliases: ["colours"], control: { type: "toggle", key: "colors" } },
          ...TONES.map((name, i) => ({ name, visible: () => s().colors, control: { type: "color", key: `tone${i + 1}` } })),
          {
            name: "Back to the built-in colors",
            visible: custom,
            action: async () => {
              await this.plugin.update({ toneColors: ["", "", "", "", ""] });
              this.update();
            },
          },
          { name: "Practice mode", desc: "Hide the pinyin until you point at a character, or tap it on a touch screen.", control: { type: "toggle", key: "hover" } },
          { name: "Size", desc: "Pinyin size, as a percentage of the text.", control: { type: "slider", key: "size", min: 30, max: 80, step: 5, displayFormat: (v) => `${v}%` } },
          { name: "Skip Japanese", desc: "Leave kanji alone in text that also has kana.", control: { type: "toggle", key: "skipJapanese" } },
        ],
      },
      {
        type: "group",
        heading: "Characters you know",
        items: [
          {
            name: "Hide pinyin for characters you know",
            desc: "So the pinyin shows only where you still need it. Select characters in a note and run I know the selected characters (or right-click) to add them.",
            aliases: ["known characters", "learned"],
            control: { type: "toggle", key: "hideKnown" },
          },
          {
            name: "Your characters",
            desc: "Type or paste them here; anything that isn't a Chinese character is ignored.",
            control: { type: "textarea", key: "known", placeholder: "我你他的是不了人在有", rows: 3 },
          },
        ],
      },
      {
        type: "group",
        heading: "Read aloud",
        items: [
          {
            name: "Voice",
            desc: "Select Chinese and run Read aloud (or right-click). It uses your system's voices, on your device.",
            aliases: ["speech", "pronunciation", "audio"],
            control: { type: "dropdown", key: "voice", options: Object.fromEntries([["", "Automatic"], ...this.plugin.voices().map((v) => [v.voiceURI, `${v.name} (${v.lang})`])]) },
          },
          { name: "Speed", control: { type: "slider", key: "rate", min: 0.5, max: 1.5, step: 0.1, displayFormat: (v) => `${Math.round(v * 100)}%` } },
        ],
      },
      {
        type: "group",
        heading: "Corrections",
        cls: "tahoe-pinyin-corrections",
        items: [
          {
            name: "Your readings",
            desc: "One word per line, then its pinyin, for words that come out wrong. Tone numbers work too. Or select a word in a note and run Fix pinyin.",
            control: {
              type: "textarea",
              key: "corrections",
              placeholder: "律师行 lǜ shī háng\n琴行 qin2 hang2",
              rows: 6,
              validate: (v) => parseCorrections(v).errors[0],
            },
          },
        ],
      },
    ];
  }
}
