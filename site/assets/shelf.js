// Полка с книгами. Список книг — единственное место, которое нужно
// дополнять руками при добавлении новой книги (см. CLAUDE.md §4).
const BOOKS = [
  "filosofiya",
  "kak-rabotaet-vse",
  "kosmos",
  "demo-book",
];

const bookTitles = {}; // id -> название, собирается по мере загрузки карточек — нужно для подписи заметок

async function loadShelf() {
  const grid = document.getElementById("shelf-grid");
  const cards = await Promise.all(BOOKS.map(loadBookCard));
  const valid = cards.filter(Boolean);

  if (valid.length === 0) {
    grid.replaceWith(Object.assign(document.createElement("p"), {
      className: "empty-shelf",
      textContent: "Книг пока нет.",
    }));
    return;
  }
  valid.forEach((card) => grid.appendChild(card));
  renderShelfNotes();
}

async function loadBookCard(id) {
  try {
    const res = await fetch(`data/${id}/meta.json`);
    if (!res.ok) throw new Error(res.status);
    const meta = await res.json();
    bookTitles[id] = meta.title;

    const a = document.createElement("a");
    a.className = "book-card";
    a.href = `read.html?book=${encodeURIComponent(id)}`;

    const h2 = document.createElement("h2");
    h2.textContent = meta.title;
    a.appendChild(h2);

    if (meta.subtitle) {
      const sub = document.createElement("p");
      sub.className = "subtitle";
      sub.textContent = meta.subtitle;
      a.appendChild(sub);
    }

    if (meta.stats) {
      const stats = document.createElement("p");
      stats.className = "stats";
      stats.textContent = meta.stats;
      a.appendChild(stats);
    }

    const bookmark = getBookmark(id);
    if (bookmark) {
      const totalChapters = meta.parts.reduce((n, p) => n + p.chapters.length, 0);
      const chapterNum = parseInt((JSON.parse(bookmark).chapterId || "").replace("ch-", ""), 10);
      if (totalChapters && !Number.isNaN(chapterNum)) {
        a.appendChild(progressRing(chapterNum / totalChapters));
      }

      const cont = document.createElement("span");
      cont.className = "continue";
      cont.textContent = "продолжить чтение →";
      a.appendChild(document.createElement("br"));
      a.appendChild(cont);
    }

    return a;
  } catch {
    // Книга объявлена в BOOKS, но данных нет (например, ещё не сконвертирована) —
    // тихо пропускаем карточку, а не ломаем всю полку.
    return null;
  }
}

// Кольцо прогресса чтения в углу карточки — доля прочитанных глав, а не
// просто украшение (в отличие от королевских узоров, у него есть смысл).
function progressRing(fraction) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, fraction));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "progress-ring");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.innerHTML = `
    <circle cx="18" cy="18" r="${r}" class="progress-ring-track" fill="none" stroke-width="3"/>
    <circle cx="18" cy="18" r="${r}" class="progress-ring-value" fill="none" stroke-width="3"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"
      transform="rotate(-90 18 18)" stroke-linecap="round"/>
    <text x="18" y="21" text-anchor="middle" class="progress-ring-text">${Math.round(pct * 100)}%</text>
  `;
  return svg;
}

function getBookmark(bookId) {
  try {
    return localStorage.getItem(`bookmark:${bookId}`);
  } catch {
    return null;
  }
}

// Заметки лежат в localStorage по одной книге на ключ ("notes:<id>") —
// собираем их со всех книг сразу, читателю нужен один общий список.
function getAllNotes() {
  const notes = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("notes:")) continue;
      const bookId = key.slice("notes:".length);
      const bookNotes = JSON.parse(localStorage.getItem(key) || "[]");
      bookNotes.forEach((note) => notes.push({ ...note, bookId }));
    }
  } catch {
    // ignore
  }
  return notes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function renderShelfNotes() {
  const list = document.getElementById("shelf-notes-list");
  if (!list) return;
  list.innerHTML = "";
  const notes = getAllNotes();

  if (notes.length === 0) {
    list.appendChild(Object.assign(document.createElement("p"), {
      className: "notes-empty",
      textContent: "Заметок пока нет — они появляются во время чтения.",
    }));
    return;
  }

  notes.forEach((note) => {
    const item = document.createElement("div");
    item.className = "note-item";

    const link = document.createElement("a");
    link.href = `read.html?book=${encodeURIComponent(note.bookId)}&ch=${encodeURIComponent(note.chapterId)}`;
    link.className = "note-chapter";
    link.textContent = `${bookTitles[note.bookId] || note.bookId} — ${note.chapterTitle}`;
    item.appendChild(link);

    const text = document.createElement("p");
    text.className = "note-text";
    text.textContent = note.text;
    item.appendChild(text);

    list.appendChild(item);
  });
}

function setupShelfNotesPanel() {
  const panel = document.getElementById("shelf-notes-panel");
  const overlay = document.getElementById("shelf-panel-overlay");
  const toggle = document.getElementById("shelf-notes-toggle");
  if (!panel || !toggle) return;

  toggle.addEventListener("click", () => {
    panel.classList.add("open");
    overlay.classList.add("open");
  });
  overlay.addEventListener("click", () => {
    panel.classList.remove("open");
    overlay.classList.remove("open");
  });
}

setupShelfNotesPanel();
loadShelf();
