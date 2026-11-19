// Run: node scripts/test-conversation-error-protocol.mjs
// Exercise the shipped MAIN-world observer, not a reimplementation of its parser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const conversation = '6ace8754-672c-83ee-acd0-967ddc99db21';

async function browserCase(error, route = conversation, method = 'POST', status = 200) {
  const observed = [];
  const target = method === 'GET'
    ? '/backend-api/conversation/' + conversation
    : '/backend-api/f/conversation';
  const wire = [
    'data: ' + JSON.stringify({ message: { content: { parts: ['private text'] } } }),
    'data: ' + JSON.stringify(error),
    'data: [DONE]', ''
  ].join('\n');
  const body = method === 'GET' ? JSON.stringify(error) : wire;
  const responseHeaders = { 'Content-Type': method === 'GET' ? 'application/json' : 'text/event-stream' };
  const env = {
    URL, Request, Response, TextDecoder,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + route,
      pathname: '/c/' + route },
    document: { querySelectorAll: () => [] },
    addEventListener: () => {}, removeEventListener: () => {},
    postMessage: (message) => observed.push(message),
    fetch: async () => {
      const result = new Response(body, { status, headers: responseHeaders });
      Object.defineProperty(result, 'url', { value: 'https://chatgpt.com' + target });
      // Node's synthetic Response has no internal response URL. A real browser
      // preserves that URL through clone(); emulate that transport property.
      const nativeClone = result.clone.bind(result);
      result.clone = () => {
        const cloned = nativeClone();
        Object.defineProperty(cloned, 'url', { value: 'https://chatgpt.com' + target });
        return cloned;
      };
      return result;
    }
  };
  env.window = env;
  vm.runInNewContext(source, env, { filename: 'extension/fiber.js' });
  const response = await env.fetch(target, { method });
  assert.equal(response.status, status);
  assert.equal(await response.text(), body, 'the original browser response must remain intact');
  await new Promise((resolve) => setTimeout(resolve, 15));
  return observed.filter((message) => message.source === 'clf-conversation-error')
    .map((message) => [message.conversationId, message.errorCode]);
}

assert.deepEqual(await browserCase({
  conversation_id: conversation, error_code: 'conversation_too_large',
  error: 'human-readable message is irrelevant'
}), [[conversation, 'conversation_too_large']]);
assert.deepEqual(await browserCase({ conversation_id: conversation,
  error: 'maximum length for this conversation' }), []);
assert.deepEqual(await browserCase({ conversation_id: conversation,
  error_code: 'other_failure' }), []);
assert.deepEqual(await browserCase({ conversation_id: conversation,
  error_code: 'conversation_too_large' }, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), []);
assert.deepEqual(await browserCase({ conversation_id: conversation,
  error_code: 'conversation_too_large' }, conversation, 'GET'), []);
assert.deepEqual(await browserCase({ code: 'conversation_length_exceeds_limit' },
  conversation, 'GET', 413), [[conversation, 'conversation_length_exceeds_limit']]);
assert.deepEqual(await browserCase({ code: 'conversation_length_exceeds_limit' },
  conversation, 'GET', 200), []);
assert.deepEqual(await browserCase({ code: 'conversation_length_exceeds_limit' },
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'GET', 413), []);
console.log('PASS: typed terminal SSE, exact route, negative cases, preserved response');
