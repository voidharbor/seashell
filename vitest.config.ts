import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Modules marked [pure] in the source tree import nothing from electron, fs or
 * react, so the bulk of the logic runs in a bare node environment with no
 * mocking scaffolding at all.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        // The react plugin is required here and only here: the dom project is
        // the only one that has to transform TSX.
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['test/dom/**/*.test.ts', 'test/dom/**/*.test.tsx'],
          setupFiles: ['test/dom/setup.ts'],
        },
      },
    ],
  },
})
