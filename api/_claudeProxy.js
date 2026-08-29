const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

export async function proxyClaudeRequest(content, maxTokens, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content }],
    }),
  });
  const data = await response.json();
  return { status: response.status, data };
}
