import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { proxyClaudeRequest } from './api/_claudeProxy.js'

// Mirrors api/claude.js so `npm run dev` works without needing `vercel dev`.
function claudeApiDevProxy(apiKey) {
  return {
    name: 'claude-api-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/claude', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY in .env' }));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let content, maxTokens;
        try {
          ({ content, maxTokens } = JSON.parse(body || '{}'));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        if (!content || !maxTokens) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing content or maxTokens' }));
          return;
        }
        const { status, data } = await proxyClaudeRequest(content, maxTokens, apiKey);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), claudeApiDevProxy(env.ANTHROPIC_API_KEY)],
    base: '/sole-catalog/',
  };
});
