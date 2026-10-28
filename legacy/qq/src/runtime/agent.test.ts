import { Semaphore } from '../shared/semaphore.js';
import { createConsoleReply } from '../channels/console/generator.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonalAgent } from './agent.js';
import type { AgentChannelEvents, AgentChannelFactory } from '../channels/channel.js';
import { ConversationMemory } from '../memory/memory.js';
import { SqliteSessionStore } from '../memory/store.js';

const settle = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Agent did not settle');
};

const fakeChannel = () => {
  let events: AgentChannelEvents;
  let connected = false;
  let starts = 0;
  let stops = 0;
  let succeeds = true;
  const sent: string[] = [];
  const create: AgentChannelFactory = handlers => {
    events = handlers;
    return {
      start: () => { starts++; connected = true; events.connected(); },
      stop: () => { stops++; connected = false; events.disconnected(); },
      capture: chatId => connected ? {
        connected: () => connected,
        send: async (content, target) => {
          sent.push(content);
          if (succeeds) events.acknowledged(chatId, content, String(sent.length), target);
          return succeeds;
        },
      } : undefined,
    };
  };
  return { create, sent, get events() { return events!; },
    get starts() { return starts; }, get stops() { return stops; },
    fail: () => { succeeds = false; } };
};

test('personal Agent works without QQ and isolates group/private short-term conversations', async () => {
  const channel = fakeChannel();
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const histories: string[][] = [];
  const agent = createPersonalAgent(channel.create, async (_text, history) => {
    histories.push(history.map(turn => turn.content));
    return 'reply';
  }, undefined, { memory, log: () => {} });
  try {
    agent.start(); agent.start(); assert.equal(channel.starts, 1);
    channel.events.message({ chatId: 'group', senderId: '2', messageId: 'a', content: 'group question', isMentioned: true });
    await settle(() => memory.get('group', '2').length === 2);
    channel.events.message({ chatId: 'private:2', senderId: '2', messageId: 'b', content: 'private question', isMentioned: true });
    await settle(() => memory.get('private:2', '2').length === 2);
    assert.deepEqual(histories, [[], []]);
    channel.fail();
    channel.events.message({ chatId: 'group', senderId: '2', messageId: 'c', content: 'failed question', isMentioned: true });
    await settle(() => channel.sent.length === 3);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(memory.get('group', '2').length, 2);
    agent.stop(); agent.stop(); agent.start();
    assert.equal(channel.stops, 1); assert.equal(channel.starts, 1);
    channel.events.message({ chatId: 'group', senderId: '2', messageId: 'd', content: 'after stop', isMentioned: true });
    assert.equal(histories.length, 3);
    assert.equal(memory.get('private:2', '2')[0].content, 'private question', 'injected memory remains caller-owned');
  } finally { agent.stop(); memory.close(); }
});

test('disconnect aborts an in-flight Agent task before delivery', async () => {
  const channel = fakeChannel();
  let signal: AbortSignal | undefined;
  const agent = createPersonalAgent(channel.create, async (_text, _history, current) => {
    signal = current;
    await new Promise<void>(resolve => current.addEventListener('abort', () => resolve(), { once: true }));
    return 'stale reply';
  }, undefined, { log: () => {} });
  try {
    agent.start();
    channel.events.message({ chatId: 'group', senderId: '2', messageId: 'a', content: 'question', isMentioned: true });
    await settle(() => !!signal);
    channel.events.disconnected();
    await settle(() => !!signal?.aborted);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(channel.sent, []);
  } finally { agent.stop(); }
});

test('failed channel startup cleans up once and cannot be restarted', () => {
  let starts = 0;
  let stops = 0;
  const agent = createPersonalAgent(() => ({
    start: () => { starts++; throw new Error('startup failed'); },
    stop: () => { stops++; },
    capture: () => undefined,
  }), undefined, undefined, { log: () => {} });
  assert.throws(() => agent.start(), /startup failed/);
  agent.start(); agent.stop();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test('QQ and workbench share the host model budget; cancelled waiters never call the provider',async()=>{
  const channel=fakeChannel(),slots=new Semaphore(1);let calls=0,qqCalls=0,releaseModel!:()=>void;
  const blocked=new Promise<void>(resolve=>{releaseModel=resolve;});
  const reply=createConsoleReply('key','model',9,false,async()=>{calls++;await blocked;return Response.json({choices:[{message:{content:'workbench reply'}}]});},slots);
  const agent=createPersonalAgent(channel.create,async()=>{qqCalls++;return 'QQ reply';},undefined,{slots,log:()=>{}});
  const pending=reply('console question',[],new AbortController().signal);
  try {
    agent.start();await settle(()=>calls===1);
    channel.events.message({chatId:'group',senderId:'2',messageId:'shared-budget',content:'QQ question',isMentioned:true});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(qqCalls,0);
    releaseModel();await pending;await settle(()=>channel.sent.length===1);assert.equal(qqCalls,1);
    const release=await slots.acquire();const controller=new AbortController();
    const waiting=reply('cancelled question',[],controller.signal);controller.abort();await assert.rejects(waiting);release();assert.equal(calls,1);
  } finally {releaseModel();await pending;agent.stop();}
});
