import { connect } from 'node:net';

const REPLY_MAX = 256;

const fail = (message: string): void => {
  process.stderr.write(`quarterdeck bus: ${message}\n`);
  process.exitCode = 1;
  process.stdin.destroy();
};

const relay = (socketPath: string, token: string): void => {
  const socket = connect(socketPath);
  let reply = Buffer.alloc(0);

  const onReply = (chunk: Buffer): void => {
    reply = Buffer.concat([reply, chunk]);
    const end = reply.indexOf('\n');
    if (end < 0 && reply.length <= REPLY_MAX) return;
    socket.off('data', onReply);
    const answer = reply.subarray(0, Math.max(end, 0)).toString('utf8');
    if (answer !== 'ok') {
      fail(`the bus refused this session (${answer || 'no reply'})`);
      socket.destroy();
      return;
    }
    process.stdout.write(reply.subarray(end + 1));
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
  };

  socket.on('connect', () => socket.write(`${token}\n`));
  socket.on('data', onReply);
  socket.on('error', (err) => fail(err.message));
  socket.on('close', () => process.stdin.destroy());
};

const socketPath = process.env.QUARTERDECK_BUS_SOCKET;
const token = process.env.QUARTERDECK_BUS_TOKEN;
if (!socketPath || !token)
  fail('QUARTERDECK_BUS_SOCKET and QUARTERDECK_BUS_TOKEN must be set');
else relay(socketPath, token);
