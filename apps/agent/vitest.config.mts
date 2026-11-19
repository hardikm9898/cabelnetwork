import { defineConfig } from 'vitest/config';
// Unit tests cover the pure modules (no React Native imports).
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
