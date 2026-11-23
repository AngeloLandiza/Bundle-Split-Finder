// Dev stub relay: POST a signed digest to the console. npm run relay:dev
//
//   RELAY_SECRET=dev npm run relay:dev
//   # in another terminal, after setting chrome.storage relayConfig to { url, secret }

import { createServer } from 'node:http';

import { verifyRelayPayload } from '../agent/relay';

const port = Number(process.env.RELAY_PORT ?? 8787);
const secret = process.env.RELAY_SECRET ?? 'dev';

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/digest') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const sig = req.headers['x-relay-signature'];
  if (typeof sig !== 'string' || !verifyRelayPayload(body, sig, secret)) {
    res.statusCode = 401;
    res.end('bad signature');
    return;
  }
  console.log('digest', body);
  res.statusCode = 204;
  res.end();
});

server.listen(port, () => console.log(`relay-dev on http://localhost:${port}/digest (secret set)`));