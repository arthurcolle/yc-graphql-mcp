import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Ajv2020 from 'ajv/dist/2020.js';

for (const modern of [false, true]) {
  test(`built CLI serves tools, resources and prompts over ${modern ? '2026-07-28' : 'legacy'} MCP stdio`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yc-protocol-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('dist/cli.js'),
        '--auth-file',
        join(directory, 'missing-auth.json'),
        '--port',
        '0',
        '--state-dir',
        directory,
      ],
      stderr: 'pipe',
    });
    let diagnostics = '';
    transport.stderr?.on('data', (chunk) => {
      diagnostics += chunk.toString();
    });
    const client = new Client(
      { name: 'yc-test', version: '1.0.0' },
      modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
    );
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 22);
      const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
      for (const tool of listed.tools) {
        assert.equal(tool.inputSchema.additionalProperties, false);
        ajv.compile(tool.inputSchema);
        if (tool.outputSchema) ajv.compile(tool.outputSchema);
      }
      const query = listed.tools.find((tool) => tool.name === 'yc_query')!;
      const validate = ajv.compile(query.inputSchema);
      assert.equal(validate({ query: 'query Read { id }', operationName: 'Read' }), true);
      for (const suffix of ['\n', '\r\n', '\t', '\0', '\u2028', 'é'])
        assert.equal(
          validate({ query: 'query Read { id }', operationName: 'Read' + suffix }),
          false,
        );
      assert.equal(
        validate({
          query: 'query Read { id }',
          operationName: 'Read',
          endpoint: 'https://evil.example',
        }),
        false,
      );
      const application = ajv.compile(
        listed.tools.find((tool) => tool.name === 'yc_get_application')!.inputSchema,
      );
      const validUuid = '63a4d22c-1096-443e-894b-349e9c46fabb';
      assert.equal(application({ appUuid: validUuid }), true);
      for (const suffix of ['\n', '\r\n', '\t', '\0', '\u2028'])
        assert.equal(application({ appUuid: validUuid + suffix }), false);
      const status: any = (await client.callTool({ name: 'yc_status', arguments: {} }))
        .structuredContent;
      assert.equal(status.ok, true);
      assert.equal(status.data.connected, false);
      const denied: any = (
        await client.callTool({
          name: 'yc_query',
          arguments: { query: 'mutation Write { update { id } }', operationName: 'Write' },
        })
      ).structuredContent;
      assert.equal(denied.error.code, 'MUTATION_BLOCKED');
      const registry: any = (
        await client.callTool({
          name: 'yc_register_operation',
          arguments: { query: 'query Read { id }', operationName: 'Read' },
        })
      ).structuredContent;
      assert.equal(registry.ok, true);
      const resources = await client.listResources();
      assert.equal(resources.resources.length, 4);
      const guide = await client.readResource({ uri: 'yc://guide' });
      assert.ok('text' in guide.contents[0]!);
      assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
      assert.equal((await client.listPrompts()).prompts.length, 2);
      const prompt = await client.getPrompt({
        name: 'inspect_application',
        arguments: { appUuid: validUuid },
      });
      assert.equal(prompt.messages.length, 1);
      assert.ok(!diagnostics.includes('token'));
    } finally {
      await client.close();
      for (let n = 0; n < 50 && existsSync(join(directory, 'server.lock')); n++) await delay(20);
      assert.equal(
        existsSync(join(directory, 'server.lock')),
        false,
        'server must clean up on stdio EOF',
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
