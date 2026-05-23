import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests',
    timeout: 60000,
    use: {
        baseURL: 'http://localhost:5173',
        bypassCSP: true,
        launchOptions: {
            args: ['--disable-web-security']
        }
    },
});