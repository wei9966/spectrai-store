#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTool, listTools, callTool } from './tools/registry.js';
import { registerDesktopTools } from './tools/desktop-tools.js';
import { registerShellTools } from './tools/shell-tools.js';
import { registerFileTools } from './tools/file-tools.js';
import { shell } from './helpers/PersistentShell.js';
const server = new Server({ name: 'spectrai-claw', version: '0.1.0' }, { capabilities: { tools: {} } });
// Register built-in ping tool for connectivity verification
registerTool('ping', 'Connectivity check — returns pong', {
    type: 'object',
    properties: {},
    additionalProperties: false,
}, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ status: 'pong', timestamp: Date.now() }) }],
}), { title: 'Ping', readOnlyHint: true, destructiveHint: false, idempotentHint: true });
// Register all tool modules
registerDesktopTools();
registerShellTools();
registerFileTools();
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: listTools() };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await callTool(name, (args ?? {}));
});
async function main() {
    // Eagerly bootstrap PersistentShell so first tool call doesn't pay cold-start cost
    shell.start().catch(() => { });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error('[spectrai-claw] Fatal:', error);
    process.exit(1);
});
