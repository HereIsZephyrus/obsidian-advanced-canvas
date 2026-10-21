# Literature navigation through Litnet

The literature sidebar can query the center MCP service without a local corpus copy.
Add a `remote` object to the existing `.literature-navigation/config.json`:

```json
{
  "remote": {
    "url": "https://mcp.channingtong.cn/litnet",
    "tokenFile": "/absolute/path/outside-the-vault/litnet/read-token"
  }
}
```

Preserve the other configuration fields. Reload Advanced Canvas after changing the connection.
Use the read credential. The publication credential belongs to agents and the shared workflow.

The client fetches paper metadata and Canvas routes, then queries the selected paper, pair, or tree node.
Evidence quotations load when needed. Revision changes clear the content cache.
Pagination uses one revision so concurrent publications cannot mix source versions.

Notes and generated Canvas files still synchronize normally.
If a Canvas has not arrived, navigation reports its missing path.
The remote client preserves local generation jobs without executing them or publishing a partial corpus.
Local navigation history and viewport positions remain on the client.

The service's query scopes also include components and bounded neighborhoods for agent retrieval.
The literature skill uses the same MCP service and completes publication through LitMonitor's shared workflow.

Codex, an LLM agent, wrote this implementation and its tests.
