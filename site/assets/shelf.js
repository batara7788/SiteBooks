// Полка с книгами. Список книг — единственное место, которое нужно
// дополнять руками при добавлении новой книги (см. CLAUDE.md §4).
const BOOKS = [
  "demo-book",
];

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
}

async function loadBookCard(id) {
  try {
    const res = await fetch(`data/${id}/meta.json`);
    if (!res.ok) throw new Error(res.status);
    const meta = await res.json();

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

function getBookmark(bookId) {
  try {
    return localStorage.getItem(`bookmark:${bookId}`);
  } catch {
    return null;
  }
}

loadShelf();
