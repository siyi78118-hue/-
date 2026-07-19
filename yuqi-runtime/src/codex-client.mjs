import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { ROLE_OUTPUT_SCHEMAS } from './role-schemas.mjs';

const ROLES = new Set(['memory', 'brain', 'supervisor']);

export class CodexProtocolError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'CodexProtocolError';
    this.details = details;
  }
}

export class CodexTurnError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = 'CodexTurnError';
    this.status = status;
    this.details = details;
  }
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command || 'codex';
    this.args = options.args || ['app-server'];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.store = options.store;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || 15_000;
    this.turnTimeoutMs = Number(options.turnTimeoutMs) || 180_000;
    this.clientInfo = options.clientInfo || {
      name: 'yuqi_al_bridge',
      title: 'Yuqi AL Bridge',
      version: '0.1.0'
    };
    this.nextId = 1;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.turnData = new Map();
    this.earlyCompletions = new Map();
    this.roleQueues = new Map();
    this.roleThreadPromises = new Map();
    this.stderrTail = '';
    this.stopping = false;
  }

  async start() {
    if (this.child && !this.child.killed) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
      return this;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    this.stopping = false;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.onLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
    });
    child.once('error', error => this.onProcessEnd(error));
    child.once('exit', (code, signal) => {
      if (!this.stopping) {
        this.onProcessEnd(new CodexProtocolError(
          `Codex app-server exited (${code ?? 'null'}/${signal ?? 'none'})`,
          this.stderrTail
        ));
      }
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    await this.request('initialize', {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: false }
    });
    this.notify('initialized');
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new CodexProtocolError('Codex app-server stdin is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProtocolError(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexProtocolError(
          `${pending.method} failed: ${message.error.message || 'unknown error'}`,
          message.error
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.onNotification(message);
  }

  onNotification(message) {
    if (message.id !== undefined) {
      this.write({ id: message.id, error: { code: -32601, message: 'Yuqi role threads do not accept interactive requests' } });
      return;
    }
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id || '';
    const threadId = params.threadId || '';
    if (!turnId || !threadId) return;
    const key = `${threadId}:${turnId}`;

    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const data = this.turnData.get(key) || {};
      data.text = String(params.item.text || '');
      this.turnData.set(key, data);
      return;
    }
    if (message.method !== 'turn/completed') return;

    const completion = {
      threadId,
      turnId,
      status: params.turn?.status || 'failed',
      error: params.turn?.error || null,
      text: this.turnData.get(key)?.text || ''
    };
    this.turnData.delete(key);
    const waiter = this.turnWaiters.get(key);
    if (!waiter) {
      this.earlyCompletions.set(key, completion);
      return;
    }
    this.finishTurnWaiter(key, waiter, completion);
  }

  finishTurnWaiter(key, waiter, completion) {
    clearTimeout(waiter.timeout);
    this.turnWaiters.delete(key);
    if (completion.status !== 'completed') {
      waiter.reject(new CodexTurnError(
        completion.error?.message || `Codex turn ${completion.status}`,
        completion.status,
        completion.error
      ));
      return;
    }
    if (!completion.text.trim()) {
      waiter.reject(new CodexTurnError('Codex turn completed without an agent message', completion.status));
      return;
    }
    waiter.resolve(completion);
  }

  onProcessEnd(error) {
    if (this.child) this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [key, waiter] of this.turnWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
      this.turnWaiters.delete(key);
    }
  }

  async ensureThread(role) {
    if (!ROLES.has(role)) throw new Error(`unknown Codex role: ${role}`);
    const existingPromise = this.roleThreadPromises.get(role);
    if (existingPromise) return existingPromise;
    const promise = this.ensureThreadInternal(role).finally(() => {
      if (this.roleThreadPromises.get(role) === promise) this.roleThreadPromises.delete(role);
    });
    this.roleThreadPromises.set(role, promise);
    return promise;
  }

  async ensureThreadInternal(role) {
    await this.start();
    const stored = this.store?.getSession?.(role) || '';
    const result = stored
      ? await this.request('thread/resume', { threadId: stored })
      : await this.request('thread/start', {
          cwd: this.cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only'
        });
    const threadId = result?.thread?.id;
    if (!threadId) throw new CodexProtocolError(`${stored ? 'thread/resume' : 'thread/start'} returned no thread id`);
    if (!stored) this.store?.setSession?.(role, threadId);
    return threadId;
  }

  runTurn(role, input, options = {}) {
    if (!ROLES.has(role)) return Promise.reject(new Error(`unknown Codex role: ${role}`));
    const before = this.roleQueues.get(role) || Promise.resolve();
    const current = before.catch(() => {}).then(() => this.runTurnInternal(role, input, options));
    const tail = current.then(() => {}, () => {}).finally(() => {
      if (this.roleQueues.get(role) === tail) this.roleQueues.delete(role);
    });
    this.roleQueues.set(role, tail);
    return current;
  }

  async runTurnInternal(role, input, options) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    if (!text.trim()) throw new Error('Codex turn input is empty');
    const threadId = await this.ensureThread(role);
    const result = await this.request('turn/start', {
      threadId,
      clientUserMessageId: options.clientUserMessageId || `yuqi_${role}_${randomUUID()}`,
      input: [{ type: 'text', text }],
      approvalPolicy: 'never',
      model: options.model || 'gpt-5.6-sol',
      effort: options.effort || 'high',
      outputSchema: options.outputSchema || ROLE_OUTPUT_SCHEMAS[role]
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new CodexProtocolError('turn/start returned no turn id');
    const key = `${threadId}:${turnId}`;

    const early = this.earlyCompletions.get(key);
    if (early) {
      this.earlyCompletions.delete(key);
      if (early.status !== 'completed' || !early.text.trim()) {
        throw new CodexTurnError(early.error?.message || 'Codex turn failed', early.status, early.error);
      }
      return early;
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new CodexTurnError('Codex turn timed out', 'timeout'));
      }, Number(options.turnTimeoutMs) || this.turnTimeoutMs);
      timeout.unref?.();
      this.turnWaiters.set(key, { resolve, reject, timeout });
    });
  }

  async interrupt(role, turnId) {
    const threadId = this.store?.getSession?.(role);
    if (!threadId || !turnId) return false;
    await this.request('turn/interrupt', { threadId, turnId });
    return true;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    try { child.stdin.end(); } catch {}
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 500);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.stopping = false;
  }
}
