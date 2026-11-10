import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve('dist/cli.js'),
    '--auth-file',
    resolve('.yc-graphql-mcp/auth.json'),
    '--state-dir',
    resolve('.yc-graphql-mcp/state'),
  ],
  stderr: 'pipe',
});
const client = new Client({ name: 'yc-production-live-read-check', version: '2.0.0' });
try {
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })).structuredContent;
    if (!result?.ok) throw new Error(result?.error?.code ?? 'LIVE_CHECK_FAILED');
    return result.data;
  };
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 17);
  const status = await call('yc_status');
  assert.equal(status.mode, 'direct');
  assert.equal(status.serverMutationsEnabled, false);
  const listed = await call('yc_list_applications');
  assert.ok(Array.isArray(listed.allApps));
  let applicationRead = false,
    founderRead = false;
  if (listed.allApps.length) {
    const application = await call('yc_get_application', { appUuid: listed.allApps[0].uuid });
    assert.equal(application.app.uuid, listed.allApps[0].uuid);
    applicationRead = true;
    assert.equal('productCreds' in application.app.questions, false);
    const bioUuid = application.app.applicants.find((applicant) => applicant.bio?.uuid)?.bio.uuid;
    if (bioUuid) {
      const founder = await call('yc_get_founder_profile', { bioUuid });
      assert.equal(founder.bio.uuid, bioUuid);
      founderRead = true;
      assert.equal('fphone' in founder.bio.questions, false);
    }
  }
  const after = await call('yc_status');
  const proof = {
    version: '2.0.0',
    runtime: process.version,
    protocol: 'MCP stdio',
    transport: 'direct',
    tools: tools.tools.length,
    applicationListRead: true,
    applicationRead,
    founderRead,
    authentication: after.authentication,
    storageWritable: after.storage.writable,
    mutationsEnabled: false,
    mutationsSent: 0,
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(
    '.yc-graphql-mcp/production-verification.json',
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify(proof));
} catch (error) {
  console.error(
    'Read-only live verification failed:',
    error instanceof Error ? error.message : 'LIVE_CHECK_FAILED',
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
