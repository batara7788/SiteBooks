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
  width: "normal", // "normal" — узкая колонка, "wide" — для больших мониторов
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
  scrollObserver: null,   // отслеживает, какая глава сейчас в поле зрения (для закладки/оглавления)
  loadObserver: null,     // ловит момент, когда пора подгрузить следующую часть
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
  body.dataset.width = state.settings.width;
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

// Каждая глава в режиме "часть целиком" — отдельная <section> с data-атрибутами,
// чтобы scroll-spy (IntersectionObserver) мог понять, какая глава сейчас читается.
function renderChapterSection(chapter, partId) {
  const section = document.createElement("section");
  section.dataset.chapterId = chapter.id;
  section.dataset.partId = partId;
  renderChapter(section, chapter, partId);
  return section;
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
  if (state.scrollObserver) state.scrollObserver.disconnect();
  if (state.loadObserver) state.loadObserver.disconnect();

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

function nextPartId(partId) {
  const idx = state.meta.parts.findIndex((p) => p.id === partId);
  const next = state.meta.parts[idx + 1];
  return next ? next.id : null;
}

async function appendPart(content, partId) {
  const part = await fetchPart(partId);
  const divider = document.createElement("div");
  divider.className = "part-divider";
  divider.textContent = part.title;
  content.appendChild(divider);

  part.chapters.forEach((chapter) => {
    const section = renderChapterSection(chapter, partId);
    content.appendChild(section);
    state.scrollObserver.observe(section);
  });
}

async function renderPartMode(chapterId) {
  const entry = findChapter(chapterId);
  if (!entry) return;

  if (state.scrollObserver) state.scrollObserver.disconnect();
  if (state.loadObserver) state.loadObserver.disconnect();

  const content = document.getElementById("reader-content");
  content.innerHTML = "";

  // Scroll-spy: как только заголовок главы пересекает верхнюю треть экрана,
  // считаем её текущей — обновляем закладку, оглавление и заголовок вкладки,
  // без единой перезагрузки страницы (см. просьбу «идти просто вниз»).
  state.scrollObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((e) => e.isIntersecting);
      if (!visible) return;
      const section = visible.target;
      const { chapterId: cid, partId: pid } = section.dataset;
      setBookmark(state.bookId, pid, cid);
      const url = new URL(location.href);
      url.searchParams.set("ch", cid);
      history.replaceState(null, "", url);
      const chapterTitle = section.querySelector("h2")?.textContent || "";
      document.title = `${chapterTitle} — ${state.meta.title}`;
      renderTOC();
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );

  await appendPart(content, entry.partId);

  const sentinel = document.createElement("div");
  sentinel.setAttribute("aria-hidden", "true");
  content.appendChild(sentinel);

  let loadingPartId = entry.partId;
  state.loadObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting) return;
    const next = nextPartId(loadingPartId);
    if (!next) {
      state.loadObserver.disconnect();
      sentinel.remove();
      return;
    }
    loadingPartId = next;
    sentinel.remove();
    await appendPart(content, next);
    content.appendChild(sentinel);
  }, { rootMargin: "600px" });
  state.loadObserver.observe(sentinel);

  document.getElementById("book-title").textContent = state.meta.title;
  document.title = `${entry.chapterTitle} — ${state.meta.title}`;
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
    tocPanel.classList.remove("open");
    settingsPanel.classList.remove("open");
    overlay.classList.remove("open");
  }

  document.getElementById("open-toc").addEventListener("click", () => {
    tocPanel.classList.add("open");
    overlay.classList.add("open");
  });
  document.getElementById("open-settings").addEventListener("click", () => {
    settingsPanel.classList.add("open");
    overlay.classList.add("open");
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
