import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRuntime, bootRuntime } from './helpers/build-runtime.js';

const first = 'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n';
const cases = [
 ['header', 'GET /healthz HTTP/1.1\r\nHost: localhost\r\nBad Header\r\n\r\n', '400']
];

function exchange(port, secure, invalid, delayed) {
 return new Promise((resolve, reject) => {
  const socket = secure ? tls.connect({host:'127.0.0.1',port,rejectUnauthorized:false}) : net.connect(port,'127.0.0.1');
  let raw=''; let sent=false;
  const timer=setTimeout(()=>{socket.destroy();reject(new Error('malformed request did not close promptly'));},1500);
  socket.on(secure?'secureConnect':'connect',()=>socket.write(first+(delayed?'':invalid)));
  socket.on('data',chunk=>{raw+=chunk.toString();if(delayed&&!sent&&raw.includes('\r\n\r\n')){sent=true;socket.write(invalid);}});
  socket.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});
  socket.on('close',()=>{clearTimeout(timer);resolve(raw);});
 });
}

for(const lane of ['TCP','TLS','harness']) describe(`malformed requests after a declined upgrade on ${lane}`,()=>{
 let server;let payload;
 const prefix=`DECLINE_ERRORS_${lane}_`;
 beforeAll(async()=>{
  if(lane==='harness'){const {createTestServer}=await import('../src/testing.js');server=await createTestServer({handler:{}});return;}
  if(lane==='TLS'){
   const certs=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','tls');
   process.env[prefix+'SSL_CERT']=path.join(certs,'localhost.crt');process.env[prefix+'SSL_KEY']=path.join(certs,'localhost.key');process.env[prefix+'SSL_WATCH']='0';
  }
  payload=buildRuntime({replace:{ENV_PREFIX:JSON.stringify(prefix)}});server=await bootRuntime(payload);
 },60000);
 afterAll(async()=>{await server?.close();payload?.cleanup();for(const key of ['SSL_CERT','SSL_KEY','SSL_WATCH'])delete process.env[prefix+key];});
 for(const [name,invalid,status] of cases)for(const delayed of [false,true])it(`refuses a malformed ${name} in ${delayed?'a later':'the same'} read`,async()=>{
  const raw=await exchange(server.port,lane==='TLS',invalid,delayed);
  expect([...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map(match=>match[1])).toEqual(['200',status]);
  expect(raw.toLowerCase()).toContain('connection: close');
 });
});