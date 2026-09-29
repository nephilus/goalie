import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createWorkMcpServer, loadMcpPrincipal } from '../app/mcp/server';

async function main(): Promise<void> {
  // Fail closed before accepting protocol traffic: the principal must be explicit and
  // must exist in the authoritative people table. Each tool call rechecks it too.
  const principal = await loadMcpPrincipal();
  serveStdio(
    () => createWorkMcpServer(principal.id),
    {
      legacy: 'serve',
      onerror: error => console.error('[goalie-mcp]', error),
    },
  );
}

main().catch(error => {
  console.error('[goalie-mcp]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
