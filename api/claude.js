import { proxyClaudeRequest } from "./_claudeProxy.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server misconfigured: missing ANTHROPIC_API_KEY" });
    return;
  }

  const { content, maxTokens, maxSearches } = req.body || {};
  if (!content || !maxTokens) {
    res.status(400).json({ error: "Missing content or maxTokens" });
    return;
  }

  const { status, data } = await proxyClaudeRequest(content, maxTokens, apiKey, maxSearches);
  res.status(status).json(data);
}
