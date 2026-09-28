// Колода: 108 фишек в случайном порядке. Сервер единственный, кто решает,
// что выпадет — клиент только получает id взятой фишки.
const catalog = require('./catalog');

class Deck {
  constructor(rng) {
    this.rng = rng || Math.random;
    this.ids = [];
    this.rebuild();
  }

  rebuild() {
    this.ids = catalog.CATALOG.map((t) => t.id);
    // Фишер–Йетс
    for (let i = this.ids.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      const tmp = this.ids[i];
      this.ids[i] = this.ids[j];
      this.ids[j] = tmp;
    }
  }

  draw() {
    if (this.ids.length === 0) return null;
    return this.ids.pop();
  }

  count() {
    return this.ids.length;
  }

  total() {
    return catalog.TOTAL;
  }
}

module.exports = { Deck };
