import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

// Asks a STUN server for a Binding and checks the answer is the one deploy/turn/compose.yaml's coturn should give: a
// success carrying XOR-MAPPED-ADDRESS, without the legacy MAPPED-ADDRESS, a SOFTWARE banner or the RFC 5780 NAT
// discovery attributes, each of which only enlarges what a spoofed request reflects. CI runs it against the pinned
// image started from that file, which is how an option coturn no longer knows - it stops turnserver before it
// listens - is caught before an operator meets it. Usage: node scripts/stun-probe.mjs HOST [PORT]
const [host = '127.0.0.1', port = '3478'] = process.argv.slice(2);
const id = randomBytes(12);
// Binding Request: type 0x0001, no attributes, the RFC 5389 magic cookie, then the transaction id.
const request = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), id]);
const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
let timer;
const answer = await new Promise((resolve, reject) => {
  const deadline = Date.now() + 30000;
  socket.on('message', message => { if (message.length >= 20 && message.subarray(8, 20).equals(id)) resolve(message); });
  socket.on('error', reject);
  // A relay that is still starting, or restarting after a crash, simply does not answer yet.
  const ask = () => {
    if (Date.now() > deadline) { reject(new Error(`No STUN answer from ${host}:${port} within 30 s: is turnserver running? Read its log.`)); return; }
    socket.send(request, Number(port), host);
    timer = setTimeout(ask, 500);
  };
  ask();
}).finally(() => { clearTimeout(timer); socket.close(); });

const type = answer.readUInt16BE(0);
if (type !== 0x0101) throw new Error(`The answer is STUN message type 0x${type.toString(16).padStart(4, '0')}, not a Binding success.`);
const attributes = new Set();
for (let at = 20; at + 4 <= answer.length; at += 4 + Math.ceil(answer.readUInt16BE(at + 2) / 4) * 4) attributes.add(answer.readUInt16BE(at));
const unwanted = [[0x0001, 'MAPPED-ADDRESS'], [0x8022, 'SOFTWARE'], [0x802b, 'RESPONSE-ORIGIN'], [0x802c, 'OTHER-ADDRESS']].filter(([code]) => attributes.has(code));
if (!attributes.has(0x0020)) throw new Error('The answer carries no XOR-MAPPED-ADDRESS.');
if (unwanted.length) throw new Error(`The answer carries ${unwanted.map(([, name]) => name).join(', ')}, which the relay's configuration is meant to leave out.`);
console.log(`PASS: ${host}:${port} answers a STUN Binding with XOR-MAPPED-ADDRESS and none of the attributes it should leave out.`);
