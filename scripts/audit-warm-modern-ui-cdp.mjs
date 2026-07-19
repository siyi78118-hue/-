#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const screens = [
  'screen-chats', 'screen-search', 'screen-chat', 'screen-chat-info',
  'screen-contacts', 'screen-contact-profile', 'screen-discover', 'screen-moments',
  'screen-me', 'screen-self-profile', 'screen-settings', 'screen-import',
  'screen-role-plans', 'screen-stage-personas', 'screen-memory', 'screen-memory-edit',
  'screen-diagnostics', 'screen-wallet', 'screen-pay'
];

const viewports = [
  { key: '360x800', width: 360, height: 800 },
  { key: '393x873', width: 393, height: 873 },
  { key: '520x900', width: 520, height: 900 }
];

const expectedProbeCount = 57;
const primaryControlSelector = [
  '.icon-btn',
  '.top-text-btn',
  '.search-cancel',
  '.primary',
  '.secondary',
  '.inline-btn',
  '.composer-tool',
  '.send',
  '.voice-hold',
  '.batch-finish',
  '.moment-compose-actions button',
  '.moment-reply-bar button',
  '.plus-item',
  '.message-action-sheet button'
].join(',');

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    result[name.slice(2)] = value;
    index += 1;
  }
  if (!result.cdp) throw new Error('Required option missing: --cdp');
  if (!result.output) throw new Error('Required option missing: --output');
  if (Boolean(result.url) === Boolean(result['target-url-prefix'])) {
    throw new Error('Supply exactly one of --url or --target-url-prefix');
  }
  return {
    cdp: result.cdp.replace(/\/$/, ''),
    hostedUrl: result.url || '',
    targetUrlPrefix: result['target-url-prefix'] || '',
    output: result.output
  };
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

class CdpConnection {
  constructor(socketUrl) {
    this.socketUrl = socketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async open() {
    this.socket = new WebSocket(this.socketUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      const handleOpen = () => {
        cleanup();
        resolvePromise();
      };
      const handleError = event => {
        cleanup();
        rejectPromise(new Error(`Unable to connect to CDP WebSocket: ${event?.message || 'connection error'}`));
      };
      const cleanup = () => {
        this.socket.removeEventListener('open', handleOpen);
        this.socket.removeEventListener('error', handleError);
      };
      this.socket.addEventListener('open', handleOpen);
      this.socket.addEventListener('error', handleError);
    });
    this.socket.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`CDP connection closed while waiting for ${pending.method}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function getTargets(cdpBase) {
  const response = await fetch(`${cdpBase}/json/list`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  const targets = await response.json();
  return targets.filter(target => target.webSocketDebuggerUrl && ['page', 'webview'].includes(target.type));
}

async function findTarget(options) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = await getTargets(options.cdp);
    const target = options.targetUrlPrefix
      ? targets.find(candidate => candidate.url.startsWith(options.targetUrlPrefix))
      : targets.find(candidate => candidate.url === options.hostedUrl) || targets[0];
    if (target) return target;
    await sleep(250);
  }
  const description = options.targetUrlPrefix || options.hostedUrl;
  throw new Error(`No debuggable page target found for ${description}`);
}

async function evaluate(connection, expression) {
  const response = await connection.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false
  });
  if (response.exceptionDetails) {
    throw new Error(`Page evaluation failed: ${response.exceptionDetails.text || 'unknown exception'}`);
  }
  return response.result?.value;
}

async function waitForDocument(connection, { expectedUrl = '', requireReloaded = false } = {}) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await evaluate(connection, `({
      state: document.readyState,
      url: location.href,
      reloaded: globalThis.__alWarmModernReloadPending !== true
    })`);
    const ready = status?.state === 'interactive' || status?.state === 'complete';
    const expectedLocation = !expectedUrl || status?.url === expectedUrl;
    const freshDocument = !requireReloaded || status?.reloaded === true;
    if (ready && expectedLocation && freshDocument) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for the audited document');
}

async function prepareHostedPage(connection, hostedUrl) {
  await connection.send('Page.navigate', { url: hostedUrl });
  await waitForDocument(connection, { expectedUrl: hostedUrl });
  const origin = new URL(hostedUrl).origin;
  await connection.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await evaluate(connection, `(async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
    if ('caches' in globalThis) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
    return true;
  })()`);
  await connection.send('Network.setCacheDisabled', { cacheDisabled: true });
  await evaluate(connection, `(() => {
    delete globalThis.__alWarmModernReloadPending;
    globalThis.__alWarmModernReloadPending = true;
    return true;
  })()`);
  await connection.send('Page.reload', { ignoreCache: true });
  await waitForDocument(connection, { expectedUrl: hostedUrl, requireReloaded: true });
}

function measurementExpression(screenId, viewport) {
  return `(async () => {
    const viewport = ${JSON.stringify({ width: viewport.width, height: viewport.height })};
    const screenId = ${JSON.stringify(screenId)};
    const tolerance = 1;
    const active = document.getElementById(screenId);
    const allScreens = Array.from(document.querySelectorAll('.screen'));
    allScreens.forEach(screen => screen.classList.toggle('active', screen === active));
    document.querySelectorAll('.composer-panel.show').forEach(panel => panel.classList.remove('show'));
    document.querySelectorAll('.moment-reply-bar.show').forEach(bar => bar.classList.remove('show'));
    document.querySelectorAll('.message-action-sheet.show').forEach(sheet => sheet.classList.remove('show'));
    document.querySelectorAll('.plus-menu.show').forEach(menu => menu.classList.remove('show'));
    window.scrollTo(0, 0);
    await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));

    const rect = element => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        left: Number(value.left.toFixed(2)),
        top: Number(value.top.toFixed(2)),
        right: Number(value.right.toFixed(2)),
        bottom: Number(value.bottom.toFixed(2)),
        width: Number(value.width.toFixed(2)),
        height: Number(value.height.toFixed(2))
      };
    };
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && bounds.width > 0 && bounds.height > 0;
    };
    const intersects = (left, right) => Boolean(left && right &&
      left.left < right.right - tolerance && left.right > right.left + tolerance &&
      left.top < right.bottom - tolerance && left.bottom > right.top + tolerance);
    const insideViewport = bounds => Boolean(bounds &&
      bounds.left >= -tolerance && bounds.top >= -tolerance &&
      bounds.right <= viewport.width + tolerance && bounds.bottom <= viewport.height + tolerance);

    const app = document.getElementById('app');
    const scroll = active?.querySelector('.scroll') || null;
    const topbar = active?.querySelector('.topbar') || null;
    const title = topbar?.querySelector('.top-title') || null;
    const sideControls = topbar
      ? Array.from(topbar.querySelectorAll('.top-left > *, .top-right > *')).filter(visible)
      : [];
    const footers = Array.from(document.querySelectorAll('.tabbar, .composer, .moment-reply-bar')).filter(visible);
    const widthChecks = [document.documentElement, document.body, app, active, scroll].filter(Boolean);

    const originalScrollTop = scroll ? scroll.scrollTop : 0;
    if (scroll) scroll.scrollTop = 0;
    const scrollTopReachable = !scroll || Math.abs(scroll.scrollTop) <= tolerance;
    if (scroll) scroll.scrollTop = 10000000;
    const scrollMaximum = scroll ? Math.max(0, scroll.scrollHeight - scroll.clientHeight) : 0;
    const scrollBottomReachable = !scroll || Math.abs(scroll.scrollTop - scrollMaximum) <= tolerance;
    if (scroll) scroll.scrollTop = originalScrollTop;

    const activeBounds = rect(active);
    const appBounds = rect(app);
    const titleBounds = visible(title) ? rect(title) : null;
    const sideBounds = sideControls.map(rect);
    const footerBounds = footers.map(rect);
    const controlBounds = Array.from(document.querySelectorAll(${JSON.stringify(primaryControlSelector)}))
      .filter(control => visible(control) && (active?.contains(control) || control.closest('.plus-menu, .message-action-sheet')))
      .map(rect);
    const touchTargetFailures = controlBounds.filter(bounds => bounds.width < 44 && bounds.height < 44).length;
    const horizontalOverflow = widthChecks.some(element => element.scrollWidth > element.clientWidth + tolerance);
    const viewportClipping = !active || !insideViewport(appBounds) || !insideViewport(activeBounds);
    const topbarOverlap = Boolean(titleBounds && sideBounds.some(bounds => intersects(titleBounds, bounds)));
    const footerClipping = footerBounds.some(bounds => !insideViewport(bounds));
    const warmModernStylesheetMissing = !Array.from(document.styleSheets)
      .some(sheet => String(sheet.href || '').includes('warm-modern.css'));
    const legacyGrayBackground = [active, scroll]
      .filter(Boolean)
      .some(element => getComputedStyle(element).backgroundColor === 'rgb(237, 237, 237)');
    const backstageConversationRows = document.querySelectorAll(
      '#screen-chats [data-contact-kind="memory"], ' +
      '#screen-chats [data-contact-kind="model"], ' +
      '#screen-chats [data-contact-kind="codex"], ' +
      '#screen-chats [data-contact-kind="sync"], ' +
      '#screen-chats .backstage-conversation'
    ).length;

    return {
      horizontalOverflow,
      viewportClipping,
      topbarOverlap,
      scrollTopReachable,
      scrollBottomReachable,
      footerClipping,
      touchTargetFailures,
      warmModernStylesheetMissing,
      legacyGrayBackground,
      backstageConversationRows,
      bounds: {
        viewport,
        document: {
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight
        },
        app: appBounds,
        activeScreen: activeBounds,
        scroll: rect(scroll),
        topbar: rect(topbar),
        title: titleBounds,
        sideControls: sideBounds,
        footers: footerBounds,
        touchTargets: controlBounds,
        scrollMaximum
      }
    };
  })()`;
}

function failureTypesFor(measurement) {
  const failures = [];
  if (measurement.horizontalOverflow) failures.push('horizontalOverflow');
  if (measurement.viewportClipping) failures.push('viewportClipping');
  if (measurement.topbarOverlap) failures.push('topbarOverlap');
  if (!measurement.scrollTopReachable) failures.push('scrollTopReachable');
  if (!measurement.scrollBottomReachable) failures.push('scrollBottomReachable');
  if (measurement.footerClipping) failures.push('footerClipping');
  if (measurement.touchTargetFailures > 0) failures.push('touchTargetFailures');
  if (measurement.warmModernStylesheetMissing) failures.push('warmModernStylesheetMissing');
  if (measurement.legacyGrayBackground) failures.push('legacyGrayBackground');
  if (measurement.backstageConversationRows > 0) failures.push('backstageConversationRows');
  return failures;
}

function sanitizeProbe(screenId, viewport, measurement) {
  return {
    screenId,
    viewport: viewport.key,
    boundaries: {
      horizontalOverflow: Boolean(measurement.horizontalOverflow),
      viewportClipping: Boolean(measurement.viewportClipping),
      topbarOverlap: Boolean(measurement.topbarOverlap),
      scrollTopReachable: Boolean(measurement.scrollTopReachable),
      scrollBottomReachable: Boolean(measurement.scrollBottomReachable),
      footerClipping: Boolean(measurement.footerClipping),
      touchTargetFailures: Number(measurement.touchTargetFailures || 0),
      warmModernStylesheetMissing: Boolean(measurement.warmModernStylesheetMissing),
      legacyGrayBackground: Boolean(measurement.legacyGrayBackground),
      backstageConversationRows: Number(measurement.backstageConversationRows || 0)
    },
    bounds: measurement.bounds,
    failureTypes: failureTypesFor(measurement)
  };
}

function buildReport(probes) {
  const probeKeys = probes.map(probe => `${probe.screenId}@${probe.viewport}`);
  const uniqueProbeKeys = new Set(probeKeys);
  const failureNames = [
    'horizontalOverflow', 'viewportClipping', 'topbarOverlap',
    'scrollTopReachable', 'scrollBottomReachable', 'footerClipping',
    'touchTargetFailures', 'warmModernStylesheetMissing',
    'legacyGrayBackground', 'backstageConversationRows'
  ];
  const aggregateFailures = Object.fromEntries(
    failureNames.map(name => [name, probes.filter(probe => probe.failureTypes.includes(name)).length])
  );
  const backstageConversationRows = Math.max(
    0,
    ...probes.map(probe => probe.boundaries.backstageConversationRows)
  );
  const failedProbes = probes
    .filter(probe => probe.failureTypes.length > 0)
    .map(probe => ({
      screenId: probe.screenId,
      viewport: probe.viewport,
      bounds: probe.bounds,
      failureTypes: probe.failureTypes
    }));
  const matrixComplete = probes.length === expectedProbeCount && uniqueProbeKeys.size === expectedProbeCount;
  if (!matrixComplete) aggregateFailures.incompleteProbeMatrix = 1;

  return {
    schemaVersion: 1,
    viewports: viewports.map(viewport => viewport.key),
    screenCount: screens.length,
    probeCount: probes.length,
    expectedProbeCount,
    aggregateFailures,
    backstageConversationRows,
    failedProbes,
    probes,
    chatContentsIncluded: false,
    matrixComplete
  };
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const target = await findTarget(options);
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.open();
  try {
    await connection.send('Page.enable');
    await connection.send('Runtime.enable');
    await connection.send('Network.enable');
    if (options.hostedUrl) await prepareHostedPage(connection, options.hostedUrl);
    else await waitForDocument(connection);

    const probes = [];
    for (const viewport of viewports) {
      await connection.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: viewport.width,
        screenHeight: viewport.height
      });
      for (const screenId of screens) {
        const measurement = await evaluate(connection, measurementExpression(screenId, viewport));
        probes.push(sanitizeProbe(screenId, viewport, measurement));
      }
    }

    const report = buildReport(probes);
    const outputPath = resolve(options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const passed = report.matrixComplete && report.failedProbes.length === 0;
    console.log(`${report.probeCount}/${expectedProbeCount} probes ${passed ? 'passed' : 'completed with failures'}`);
    if (!passed) process.exitCode = 1;
  } finally {
    connection.close();
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
