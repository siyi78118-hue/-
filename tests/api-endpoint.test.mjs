import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeApiBaseUrl,
  buildApiEndpoint,
  assertNonHtmlApiResponse
} = require('../tavern-app/lib/api-endpoint.js');

test('normalizes provider roots without losing the version path', () => {
  const cases = [
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/messages?debug=1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/models#list', 'https://api.example.com/v1']
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeApiBaseUrl(input, { label: '记忆接口' }), expected);
  }
  assert.equal(
    buildApiEndpoint('https://api.example.com/v1/chat/completions', 'chat/completions', { label: '记忆接口' }),
    'https://api.example.com/v1/chat/completions'
  );
});

test('rejects empty, relative, and current-app API addresses before fetch', () => {
  assert.throws(() => normalizeApiBaseUrl('', { label: '记忆接口' }), /地址为空/);
  assert.throws(() => normalizeApiBaseUrl('/v1', { label: '记忆接口' }), /完整地址/);
  assert.throws(
    () => normalizeApiBaseUrl('https://siyi78118-hue.github.io/-/tavern-app/', { label: '记忆接口' }),
    /AL.*不是模型接口/
  );
  assert.throws(
    () => normalizeApiBaseUrl('https://localhost/v1', { label: '记忆接口', appOrigin: 'https://localhost' }),
    /AL.*不是模型接口/
  );
});

test('rejects an HTML document even when the server returns HTTP 200', () => {
  const response = { headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : '' } };
  assert.throws(
    () => assertNonHtmlApiResponse('<!DOCTYPE html><html lang="zh-CN">AL</html>', response, {
      label: '记忆接口',
      endpoint: 'https://api.example.com/v1/chat/completions'
    }),
    /请求落到了网页而不是模型接口/
  );
});

test('accepts JSON model responses', () => {
  const response = { headers: { get: () => 'application/json' } };
  assert.doesNotThrow(() => assertNonHtmlApiResponse('{"choices":[]}', response, {
    label: '记忆接口',
    endpoint: 'https://api.example.com/v1/chat/completions'
  }));
});
