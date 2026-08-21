import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/dshMtFixitGateway.ts');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const importMarker = 'import { handleMtFixItResolutionRequest } from "./mtfixitResolution.js";\n';
if (!source.includes('handleChatGptHandoffDecisionRequest')) {
  if (!source.includes(importMarker)) throw new Error('DSH gateway import marker missing');
  source = source.replace(
    importMarker,
    importMarker + 'import { handleChatGptHandoffDecisionRequest } from "./chatgptHandoffDecision.js";\n',
  );
}

const routeMarker = '  if (/^\\/api\\/dsh\\/mtfixit\\/jobs\\/[a-zA-Z0-9_-]{8,100}\\/resolution$/.test(url.pathname)) {\n    return handleMtFixItResolutionRequest(request, response, env, dashboardPort);\n  }\n';
if (!source.includes('chatgpt-handoffs')) {
  if (!source.includes(routeMarker)) throw new Error('DSH gateway resolution route marker missing');
  source = source.replace(
    routeMarker,
    routeMarker
      + '  if (/^\\/api\\/dsh\\/mtfixit\\/chatgpt-handoffs\\/[A-Za-z0-9_-]{8,120}\\/decision$/.test(url.pathname)) {\n'
      + '    return handleChatGptHandoffDecisionRequest(request, response, env);\n'
      + '  }\n',
  );
}

fs.writeFileSync(target, source, 'utf8');
console.log('ChatGPT handoff DSH decision route patched.');
