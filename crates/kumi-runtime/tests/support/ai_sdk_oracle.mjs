// The installed TypeScript SDK is the behavioral oracle for the native model adapters.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
let input = '';
for await (const bytes of process.stdin) input += bytes;
const test = JSON.parse(input);
let request;
const fetch = async (url, init) => {
  request = { url: String(url), body: JSON.parse(init.body) };
  return new Response(test.events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const settings = { baseURL: 'http://fixture/v1', apiKey: 'fixture-key', fetch };
const model = test.provider === 'anthropic' ? createAnthropic(settings).messages(test.model)
  : test.provider === 'openai' ? createOpenAI(settings).responses(test.model)
  : createOpenAICompatible({ ...settings, name: test.name ?? 'fixture', includeUsage: true }).chatModel(test.model);
const answer = await model.doStream(test.options);
const parts = [];
// Rust represents JavaScript Date values as epoch milliseconds.
for await (const part of answer.stream) parts.push(part.type === "response-metadata" && part.timestamp instanceof Date ? { ...part, timestamp: part.timestamp.getTime() } : part);
process.stdout.write(JSON.stringify({ request, parts }));
