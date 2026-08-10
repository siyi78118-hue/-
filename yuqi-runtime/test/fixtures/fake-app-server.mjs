import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logFile = process.env.FAKE_APP_SERVER_LOG || '';
let threadCounter = 0;
let turnCounter = 0;
const threads = new Map();

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function log(message) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(message)}\n`, 'utf8');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log(message);
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    write({ id: message.id, result: { userAgent: 'fake-app-server', codexHome: 'fake', platformFamily: 'windows', platformOs: 'windows' } });
    return;
  }
  if (message.method === 'thread/start') {
    const id = `thr_new_${++threadCounter}`;
    threads.set(id, []);
    write({ id: message.id, result: { thread: { id, status: { type: 'idle' } } } });
    write({ method: 'thread/started', params: { thread: { id, status: { type: 'idle' } } } });
    return;
  }
  if (message.method === 'thread/resume') {
    if (message.params.threadId === 'thr_missing') {
      write({ id: message.id, error: { code: -32001, message: 'no rollout found for thread id thr_missing' } });
      return;
    }
    if (message.params.threadId === 'thr_denied') {
      write({ id: message.id, error: { code: -32002, message: 'permission denied' } });
      return;
    }
    write({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: 'idle' } } } });
    return;
  }
  if (message.method === 'thread/read') {
    const storedTurns = threads.get(message.params.threadId);
    write({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          status: { type: 'idle' },
          turns: message.params.includeTurns === true
            ? (storedTurns || [{ id: 'turn_existing_1', status: 'completed', items: [], error: null }])
            : []
        }
      }
    });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = `turn_fake_${++turnCounter}`;
    const text = message.params.input?.find(item => item.type === 'text')?.text || '';
    const output = text.includes('find evidence') ? '{"query":"promise"}' : `reply:${text}`;
    const completedTurn = {
      id: turnId,
      status: 'completed',
      error: null,
      items: [
        {
          id: `user_${turnId}`,
          type: 'userMessage',
          clientId: message.params.clientUserMessageId,
          content: message.params.input
        },
        { id: `item_${turnId}`, type: 'agentMessage', text: output }
      ]
    };
    const storedTurns = threads.get(message.params.threadId) || [];
    storedTurns.push(completedTurn);
    threads.set(message.params.threadId, storedTurns);
    write({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
    write({ method: 'item/agentMessage/delta', params: { threadId: 'unrelated', turnId: 'turn_other', itemId: 'item_other', delta: 'ignore' } });
    write({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, itemId: `item_${turnId}`, delta: output.slice(0, 5) } });
    write({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: { id: `item_${turnId}`, type: 'agentMessage', text: output } } });
    write({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
    return;
  }
  if (message.method === 'turn/interrupt') {
    write({ id: message.id, result: {} });
    return;
  }
  write({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
