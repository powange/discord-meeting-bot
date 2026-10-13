import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Les tests d'intégration recréent chacun leur base PostgreSQL et appliquent toutes les
    // migrations, en parallèle : sur une machine chargée, cela dépasse parfois 10 s.
    hookTimeout: 60_000,
  },
});
