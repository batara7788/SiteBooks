// Читалка. Работает с данными book в site/data/<id>/ — meta.json (оглавление)
// и по одному JSON-файлу на часть. Никакого сервера: всё состояние читателя
// (тема, шрифт, закладка) живёт в localStorage (см. CLAUDE.md §2 и §7).

const SETTINGS_KEY = "reader-settings";
const DEFAULT_SETTINGS = {
  theme: "light",
  font: "slab",
  size: "2",
  leading: "normal",
  mode: "chapter", // "chapter" — по главам, "part" — часть целиком
};

const BOX_LABELS = {
  "two-words": "В двух словах",
  "chapter-gist": "Главное из главы",
  "interesting": "Это интересно",
  "original-term": "Слово в оригинале",
  "misconception": "Распространённое заблуждение",
  "debate": "Спорный вопрос",
  "thought-experiment": "Мысленный эксперимент",
  "formula": "Формула",
  "quote": "Цитата",
  "how-discovered": "А как к этому пришли?",
  "timeline": "Мини-таймлайн",
  "philosopher-life": "Жизнь философа",
};

const state = {
  bookId: null,
  meta: null,
  settings: loadSettings(),
  chapterIndex: [], // [{ chapterId, partId, partTitle, chapterTitle }]
  partCache: new Map(),
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — просто не сохраняем.
  }
}

function applySettings() {
  const body = document.body;
  body.dataset.theme = state.settings.theme;
  body.dataset.font = state.settings.font;
  body.dataset.size = state.settings.size;
  body.dataset.leading = state.settings.leading;
  document.querySelectorAll("[data-setting]").forEach((btn) => {
    const [group, value] = [btn.dataset.setting, btn.dataset.value];
    btn.classList.toggle("active", state.settings[group] === value);
  });
}

function getBookmark(bookId) {
  try {
    const raw = localStorage.getItem(`bookmark:${bookId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setBookmark(bookId, partId, chapterId) {
  try {
    localStorage.setItem(`bookmark:${bookId}`, JSON.stringify({ partId, chapterId }));
  } catch {
    // ignore
  }
}

async function fetchPart(partId) {
  if (state.partCache.has(partId)) return state.partCache.get(partId);
  const res = await fetch(`data/${state.bookId}/${partId}.json`);
  if (!res.ok) throw new Error(`Не удалось загрузить часть ${partId}`);
  const data = await res.json();
  state.partCache.set(partId, data);
  return data;
}

function renderBlock(block) {
  switch (block.type) {
    case "heading3": {
      const h = document.createElement("h3");
      h.innerHTML = block.html;
      return h;
    }
    case "p": {
      const p = document.createElement("p");
      p.innerHTML = block.html;
      return p;
    }
    case "list": {
      const ul = document.createElement("ul");
      block.items.forEach((item) => {
        const li = document.createElement("li");
        li.innerHTML = item;
        ul.appendChild(li);
      });
      return ul;
    }
    case "box": {
      const div = document.createElement("div");
      div.className = `box kind-${block.kind}`;
      const label = document.createElement("span");
      label.className = "box-label";
      label.textContent = BOX_LABELS[block.kind] || block.kind;
      div.appendChild(label);
      block.html.forEach((paraHtml) => {
        const p = document.createElement("p");
        p.innerHTML = paraHtml;
        div.appendChild(p);
      });
      return div;
    }
    case "table": {
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      const table = document.createElement("table");
      block.rows.forEach((row, ri) => {
        const tr = document.createElement("tr");
        row.forEach((cell) => {
          const cellEl = document.createElement(ri === 0 ? "th" : "td");
          cellEl.innerHTML = cell;
          tr.appendChild(cellEl);
        });
        table.appendChild(tr);
      });
      wrap.appendChild(table);
      return wrap;
    }
    case "image": {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = `data/${state.bookId}/${block.src}`;
      img.alt = block.caption || "";
      img.loading = "lazy";
      figure.appendChild(img);
      if (block.caption) {
        const cap = document.createElement("figcaption");
        cap.textContent = block.caption;
        figure.appendChild(cap);
      }
      return figure;
    }
    default:
      return document.createComment(`unknown block: ${block.type}`);
  }
}

function renderChapter(container, chapter, partTitle) {
  const h2 = document.createElement("h2");
  h2.textContent = chapter.title;
  container.appendChild(h2);
  chapter.blocks.forEach((block) => container.appendChild(renderBlock(block)));
}

function buildChapterIndex(meta) {
  const index = [];
  meta.parts.forEach((part) => {
    part.chapters.forEach((chapter) => {
      index.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        partId: part.id,
        partTitle: part.title,
      });
    });
  });
  return index;
}

function findChapter(chapterId) {
  return state.chapterIndex.find((c) => c.chapterId === chapterId);
}

function renderTOC() {
  const toc = document.getElementById("toc-content");
  toc.innerHTML = "";
  state.meta.parts.forEach((part) => {
    const wrap = document.createElement("div");
    wrap.className = "toc-part";
    const title = document.createElement("div");
    title.className = "toc-part-title";
    title.textContent = part.title;
    wrap.appendChild(title);
    part.chapters.forEach((chapter) => {
      const a = document.createElement("a");
      a.className = "toc-chapter";
      a.href = `read.html?book=${state.bookId}&ch=${chapter.id}`;
      a.textContent = chapter.title;
      if (chapter.id === currentChapterId()) a.classList.add("current");
      wrap.appendChild(a);
    });
    toc.appendChild(wrap);
  });
}

function currentChapterId() {
  return new URLSearchParams(location.search).get("ch");
}

function updateProgressBar() {
  const bar = document.getElementById("progress-bar");
  const doc = document.documentElement;
  const scrolled = doc.scrollTop;
  const height = doc.scrollHeight - doc.clientHeight;
  const pct = height > 0 ? (scrolled / height) * 100 : 0;
  bar.style.width = `${pct}%`;
}

async function renderChapterMode(chapterId) {
  const entry = findChapter(chapterId);
  if (!entry) {
    document.getElementById("reader-content").textContent = "Глава не найдена.";
    return;
  }
  const part = await fetchPart(entry.partId);
  const chapter = part.chapters.find((c) => c.id === chapterId);

  const content = document.getElementById("reader-content");
  content.innerHTML = "";
  renderChapter(content, chapter, entry.partTitle);

  const idx = state.chapterIndex.findIndex((c) => c.chapterId === chapterId);
  const prev = state.chapterIndex[idx - 1];
  const next = state.chapterIndex[idx + 1];

  const nav = document.createElement("div");
  nav.className = "chapter-nav";
  nav.appendChild(navLink(prev, "← назад"));
  nav.appendChild(navLink(next, "дальше →"));
  content.appendChild(nav);

  document.getElementById("book-title").textContent = state.meta.title;
  document.title = `${chapter.title} — ${state.meta.title}`;
  setBookmark(state.bookId, entry.partId, chapterId);
  window.scrollTo(0, 0);
  renderTOC();
}

function navLink(entry, label) {
  const a = document.createElement("a");
  if (entry) {
    a.href = `read.html?book=${state.bookId}&ch=${entry.chapterId}`;
    a.textContent = label;
  } else {
    a.textContent = "";
  }
  return a;
}

async function renderPartMode(chapterId) {
  const entry = findChapter(chapterId);
  if (!entry) return;
  const part = await fetchPart(entry.partId);

  const content = document.getElementById("reader-content");
  content.innerHTML = "";
  const divider = document.createElement("div");
  divider.className = "part-divider";
  divider.textContent = part.title;
  content.appendChild(divider);

  part.chapters.forEach((chapter) => renderChapter(content, chapter, part.title));

  document.getElementById("book-title").textContent = state.meta.title;
  document.title = `${part.title} — ${state.meta.title}`;
  setBookmark(state.bookId, entry.partId, chapterId);
  renderTOC();
}

async function renderCurrentChapter() {
  const chapterId = currentChapterId() || state.chapterIndex[0]?.chapterId;
  if (!chapterId) return;
  if (state.settings.mode === "part") {
    await renderPartMode(chapterId);
  } else {
    await renderChapterMode(chapterId);
  }
}

function setupPanels() {
  const tocPanel = document.getElementById("toc-panel");
  const settingsPanel = document.getElementById("settings-panel");
  const overlay = document.getElementById("panel-overlay");

  function closeAll() {
    tocPanel.hidden = true;
    settingsPanel.hidden = true;
    overlay.hidden = true;
  }

  document.getElementById("open-toc").addEventListener("click", () => {
    tocPanel.hidden = false;
    overlay.hidden = false;
  });
  document.getElementById("open-settings").addEventListener("click", () => {
    settingsPanel.hidden = false;
    overlay.hidden = false;
  });
  overlay.addEventListener("click", closeAll);

  document.querySelectorAll("[data-setting]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { setting, value } = btn.dataset;
      state.settings[setting] = value;
      saveSettings();
      applySettings();
      if (setting === "mode") renderCurrentChapter();
    });
  });
}

async function initReader() {
  const params = new URLSearchParams(location.search);
  state.bookId = params.get("book");
  if (!state.bookId) {
    document.getElementById("reader-content").textContent = "Книга не указана.";
    return;
  }

  applySettings();
  setupPanels();
  window.addEventListener("scroll", updateProgressBar, { passive: true });

  const res = await fetch(`data/${state.bookId}/meta.json`);
  if (!res.ok) {
    document.getElementById("reader-content").textContent = "Не удалось загрузить книгу.";
    return;
  }
  state.meta = await res.json();
  state.chapterIndex = buildChapterIndex(state.meta);

  if (!currentChapterId()) {
    const bookmark = getBookmark(state.bookId);
    const startChapter = bookmark?.chapterId || state.chapterIndex[0]?.chapterId;
    if (startChapter) {
      const url = new URL(location.href);
      url.searchParams.set("ch", startChapter);
      history.replaceState(null, "", url);
    }
  }

  await renderCurrentChapter();
}

window.addEventListener("popstate", () => renderCurrentChapter());
initReader();
